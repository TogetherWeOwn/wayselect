// Purchase-refusal body contract (TOG-6384, gap T6 from TOG-6346).
//
// TOG-6032 pinned the purchase route's encoding edges (statuses 403/404/405)
// but never the exact 403 body: the `preview_only` refusal in web/server.js
// could gain, lose, or reword a field and no test would fail. This file pins
// the body that goes with the 403:
//
//   - status 403 with the JSON content-type;
//   - body is exactly `{ error: "preview_only", message: "Purchases are
//     disabled in preview. No backend writes.", requestId }` — no more, no
//     fewer keys (`requestId` is the TOG-6717 triage id, 32 lowercase hex,
//     echoed from the `x-request-id` header);
//   - `error` is the string "preview_only"; `message` is the exact string
//     above, verbatim (client copy depends on it);
//   - identical for every stub listing (`STUB_LISTINGS`, iterated — a new
//     stub listing is covered automatically) with the flag on and off
//     (ungated by design: a refuse-stub has no preview-only behavior to
//     gate) and with a trailing slash;
//   - 403 is only for real listings: unknown ids 404 `listing_not_found`
//     first (TOG-5710 boundary), so a 403 always means "listing exists,
//     writes disabled".
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

const JSON_CT = "application/json; charset=utf-8";
const REFUSAL_BODY = Object.freeze({
  error: "preview_only",
  message: "Purchases are disabled in preview. No backend writes.",
});

describe("purchase refusal body contract (TOG-6384)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postPurchase(base, listing) {
    const res = await fetch(
      `${base}/listings/${listing.providerId}/${listing.modelId}/purchase`,
      { method: "POST" },
    );
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      requestIdHeader: res.headers.get("x-request-id"),
      body: await res.json(),
    };
  }

  // Exact shape: an added, dropped, or reworded field fails here, not on a
  // prod client. The refusal copy stays byte-identical (REFUSAL_BODY); the
  // TOG-6717 triage id rides alongside it, echoed from the header.
  function assertRefusal(reply, where) {
    deepStrictEqual(
      { error: reply.body.error, message: reply.body.message },
      { ...REFUSAL_BODY },
      `${where}: refusal copy`,
    );
    ok(/^[0-9a-f]{32}$/.test(reply.body.requestId ?? ""), `${where}: requestId is 32 lowercase hex`);
    strictEqual(reply.requestIdHeader, reply.body.requestId, `${where}: header and body agree`);
    deepStrictEqual(
      Object.keys(reply.body).sort(),
      ["error", "message", "requestId"],
      `${where}: no extra fields`,
    );
  }

  it("refuses every stub listing with the exact body (flag on)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const listing of STUB_LISTINGS) {
      const route = `${listing.providerId}/${listing.modelId}`;
      const { status, contentType, ...reply } = await postPurchase(base, listing);
      strictEqual(status, 403, route);
      strictEqual(contentType, JSON_CT, route);
      assertRefusal(reply, route);
    }
  });

  it("refuses identically with the flag off and with a trailing slash", async () => {
    const off = await start({});
    const listing = STUB_LISTINGS[0];
    const route = `${listing.providerId}/${listing.modelId}`;
    // Ungated by design (accept-wayselect-checkout G2): the stub refuses
    // even when preview content routes are hidden.
    const refused = await postPurchase(off, listing);
    strictEqual(refused.status, 403, `${route} (flag off)`);
    assertRefusal(refused, `${route} (flag off)`);
    // Trailing slash is the same route, not a different refusal.
    const res = await fetch(`${off}/listings/${route}/purchase/`, { method: "POST" });
    strictEqual(res.status, 403, `${route}/ (trailing slash)`);
    strictEqual(res.headers.get("content-type"), JSON_CT, `${route}/ (trailing slash)`);
    assertRefusal(
      { requestIdHeader: res.headers.get("x-request-id"), body: await res.json() },
      `${route}/ (trailing slash)`,
    );
  });

  it("404s unknown listings first: 403 always means a real listing", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const missing = await fetch(`${base}/listings/a/b/purchase`, { method: "POST" });
    strictEqual(missing.status, 404);
    strictEqual((await missing.json()).error, "listing_not_found");
  });
});
