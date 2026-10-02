// Origin/Referer CSRF guard on the purchase POST (TOG-6366, gap G5/S1).
//
// Threat model: CSP `form-action 'self'` is enforced by the victim's browser
// only when that browser honors the header — a hostile page on another
// origin can still submit a cross-origin POST to the purchase route and ride
// the victim's ambient credentials (cookies/session) once this route writes.
// The stub refuses with 403 today, so impact is nil; this 403
// `forbidden_origin` check is defense-in-depth that survives the day the
// route writes, so it compares the request's own Origin (else Referer)
// authority against its Host and refuses mismatches before the listing
// lookup — a cross-origin probe cannot tell 404 (unknown listing) from 403
// (real listing).
//
// Contract pinned here:
//   - no Origin/Referer (curl, non-browser API clients): reaches the stub
//     refusal (403 preview_only) — headerless requests are NOT cross-origin;
//   - matching Origin, matching Referer-only, and Origin-preferred-over-
//     Referer: reach the stub refusal (same-origin, TOG-5710 ordering kept);
//   - mismatched Origin, mismatched Referer-only, mismatched port, and
//     unparseable values: 403 `forbidden_origin` for known AND unknown
//     listings (pre-lookup, still JSON + nosniff + requestId);
//   - 405 (wrong method) and 429 (rate limit) precede the guard;
//   - `Cache-Control: no-store` rides the refusal (dynamic error JSON,
//     TOG-6367), so no `Vary: Origin` is needed for shared caches.
//
// node:test, zero dependencies. Browser Origin/Referer values are injected
// via fetch headers (fetch forbids overriding Host, so Host is always the
// loopback server — cross-origin is simulated with a hostile Origin/Referer
// against the loopback Host, which is exactly the browser CSRF shape:
// browser-forged Origin vs URL-derived Host).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp, isSameOriginRequest } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const NOSNIFF = "nosniff";
const KNOWN = "/listings/northstar/alpha-chat/purchase";
const UNKNOWN = "/listings/northstar/nope/purchase";
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

describe("purchase origin check (TOG-6366)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postPurchase(base, path, headers = {}) {
    const res = await fetch(`${base}${path}`, { method: "POST", headers });
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      nosniff: res.headers.get("x-content-type-options"),
      cacheControl: res.headers.get("cache-control"),
      requestIdHeader: res.headers.get("x-request-id"),
      body: await res.json(),
    };
  }

  function assertForbiddenOrigin(reply, where) {
    strictEqual(reply.status, 403, `${where}: status`);
    strictEqual(reply.contentType, JSON_CT, `${where}: content-type`);
    strictEqual(reply.nosniff, NOSNIFF, `${where}: nosniff`);
    strictEqual(reply.cacheControl, "no-store", `${where}: no-store`);
    ok(REQUEST_ID_RE.test(reply.requestIdHeader ?? ""), `${where}: requestId header`);
    strictEqual(reply.body.requestId, reply.requestIdHeader, `${where}: header/body agree`);
    deepStrictEqual(
      Object.keys(reply.body).sort(),
      ["error", "requestId"],
      `${where}: body is exactly error + requestId`,
    );
    strictEqual(reply.body.error, "forbidden_origin", `${where}: error code`);
  }

  function assertPreviewOnly(reply, where) {
    // The stub refusal: unchanged copy (TOG-6384 owns the exact body),
    // reached only for same-origin or headerless requests.
    strictEqual(reply.status, 403, `${where}: status`);
    strictEqual(reply.body.error, "preview_only", `${where}: stub refusal`);
    strictEqual(
      reply.body.message,
      "Purchases are disabled in preview. No backend writes.",
      `${where}: refusal copy intact`,
    );
  }

  it("reaches the stub refusal without Origin/Referer (curl / API clients)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // node fetch sends neither header on a plain POST (probed 2026-09-28):
    // a headerless request is not evidence of a foreign origin.
    assertPreviewOnly(await postPurchase(base, KNOWN), "headerless known");
    const unknown = await postPurchase(base, UNKNOWN);
    strictEqual(unknown.status, 404, "headerless unknown: TOG-5710 ordering kept");
    strictEqual(unknown.body.error, "listing_not_found", "headerless unknown: shape");
  });

  it("reaches the stub refusal for same-origin Origin and Referer", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const { origin } = new URL(base);
    // Exact match on the header the browser mints for the page's own form.
    assertPreviewOnly(await postPurchase(base, KNOWN, { origin }), "same-origin Origin");
    // Headerless browsers/proxies that strip Origin but keep Referer.
    assertPreviewOnly(
      await postPurchase(base, KNOWN, { referer: `${base}/listings/northstar/alpha-chat` }),
      "same-origin Referer-only",
    );
  });

  it("prefers Origin over Referer when both are present", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const { origin } = new URL(base);
    // A hostile intermediary cannot launder a foreign Origin behind a
    // same-origin Referer: Origin wins, the request refuses.
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, {
        origin: "http://evil.invalid",
        referer: `${base}/listings/northstar/alpha-chat`,
      }),
      "foreign Origin + same-origin Referer",
    );
    // ...and a same-origin Origin wins over a hostile Referer too.
    assertPreviewOnly(
      await postPurchase(base, KNOWN, {
        origin,
        referer: "http://evil.invalid/lure",
      }),
      "same-origin Origin + foreign Referer",
    );
  });

  it("refuses mismatched Origin before the listing lookup (known and unknown)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Same refusal for a real listing and a miss: a cross-origin probe
    // learns nothing about which listings exist.
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, { origin: "http://evil.invalid" }),
      "foreign Origin, known listing",
    );
    assertForbiddenOrigin(
      await postPurchase(base, UNKNOWN, { origin: "http://evil.invalid" }),
      "foreign Origin, unknown listing",
    );
    // Referer-only attackers (form-post CSRF without fetch) refuse too.
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, { referer: "http://evil.invalid/lure" }),
      "foreign Referer-only, known listing",
    );
    // Different port is a different authority — a sibling service's page
    // cannot drive this purchase route.
    const { port } = new URL(base);
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, { origin: `http://127.0.0.1:${Number(port) + 1}` }),
      "same host, wrong port",
    );
  });

  it("fails closed on present-but-unparseable values", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, { origin: "not a url (((" }),
      "garbage Origin",
    );
    assertForbiddenOrigin(
      await postPurchase(base, KNOWN, { referer: "http://[::1" }),
      "garbage Referer",
    );
  });

  it("unit: isSameOriginRequest allows headerless (non-browser) requests", () => {
    // Browsers always attach Origin to cross-origin POSTs; a non-browser
    // client (curl) attaches nothing and is not a confused deputy.
    ok(isSameOriginRequest({ headers: {} }), "no headers: allowed");
    ok(isSameOriginRequest({ headers: { host: "127.0.0.1:9" } }), "host only: allowed");
  });

  it("unit: isSameOriginRequest compares authorities, not schemes", () => {
    const host = "127.0.0.1:3000";
    ok(
      isSameOriginRequest({ headers: { host, origin: "https://127.0.0.1:3000" } }),
      "https Origin vs http Host: same authority",
    );
    ok(
      !isSameOriginRequest({ headers: { host, origin: "http://127.0.0.1:3001" } }),
      "port mismatch: refused",
    );
    ok(
      !isSameOriginRequest({ headers: { host, origin: "notaurl" } }),
      "unparseable Origin: refused",
    );
  });

  it("guard order: 405 and the listing check precede/follow the guard correctly", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Wrong method is a routing fact, not an origin verdict: 405 with the
    // Allow header even with a hostile Origin.
    const get = await fetch(`${base}${KNOWN}`, {
      method: "GET",
      headers: { origin: "http://evil.invalid" },
    });
    strictEqual(get.status, 405, "GET purchase with hostile Origin: 405");
    strictEqual(get.headers.get("allow"), "POST", "405 carries Allow: POST");
    // 429 (rate limit) also precedes: a saturated bucket answers 429 even
    // for same-origin requests. (`max: 0` is not a valid floor — the
    // limiter falls back to its default — so the bucket is saturated with
    // a first hit that spends the only token.)
    const limited = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    const limitedOrigin = `http://127.0.0.1:${new URL(limited).port}`;
    const first = await postPurchase(limited, KNOWN, { origin: limitedOrigin });
    strictEqual(first.status, 403, "first hit spends the bucket on the stub refusal");
    const denied = await postPurchase(limited, KNOWN, { origin: limitedOrigin });
    strictEqual(denied.status, 429, "saturated bucket: 429 precedes origin/p stub");
    strictEqual(denied.body.error, "rate_limited", "429 shape");
  });
});
