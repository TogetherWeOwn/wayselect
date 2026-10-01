// Flag-on index JSON negotiation (TOG-7661, impl TOG-7830).
//
// `GET /listings` with `Accept: application/json` returns the machine-readable
// result/error payload instead of the HTML page, so `fetch(...).json()` never
// parses HTML (the TOG-5499 failure mode on the detail side):
//   - 200 paged result `{listings, total, limit, offset}` — including the
//     empty state (`?q=zzz-no-such-listing`) and offset-past-end (`?offset=999`,
//     empty page with the intact total);
//   - 400 `{error: "invalid_filter", kind, value, valid, errors}` for every
//     invalid-filter kind (bad capability, bad modality, bad sort, bad limit,
//     bad offset, unknown key, over-long q), plus the TOG-6717 triage
//     `requestId` echoed from the `x-request-id` header like every JSON error;
//   - HTML stays the default for browsers (no Accept, text/html); a client
//     negotiating both stays on JSON (same rule as the detail fragment);
//   - `Vary: Accept` on every variant so a shared cache keys on it;
//   - the flag-off index stays HTML-only even under JSON negotiation (it has
//     no fragment shape) — pinned in preview-disabled-json.test.js.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";
const JSON_CT = "application/json; charset=utf-8";

describe("flag-on index JSON negotiation (TOG-7661)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function get(base, path, accept) {
    const headers = accept === undefined ? {} : { accept };
    const res = await fetch(`${base}${path}`, { headers });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      vary: res.headers.get("vary"),
      requestIdHeader: res.headers.get("x-request-id"),
      text,
    };
  }

  it("returns the empty result as JSON with Vary: Accept", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await get(base, "/listings?q=zzz-no-such-listing", "application/json");
    strictEqual(res.status, 200);
    strictEqual(res.contentType, JSON_CT);
    strictEqual(res.vary, "Accept");
    deepStrictEqual(JSON.parse(res.text), { listings: [], total: 0, limit: 20, offset: 0 });
  });

  it("returns invalid-filter 400s as JSON for every filter kind", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const cases = [
      ["/listings?capability=__bogus__", "capability", "__bogus__"],
      ["/listings?modality=bogus", "modality", "bogus"],
      ["/listings?sort=bogus", "sort", "bogus"],
      ["/listings?limit=abc", "limit", "abc"],
      ["/listings?offset=abc", "offset", "abc"],
      ["/listings?limit=0", "limit", "0"],
      [`/listings?q=${"a".repeat(201)}`, "q", "a".repeat(64)],
      ["/listings?capabilty=tool_call", "query", "capabilty"],
    ];
    for (const [path, kind, value] of cases) {
      const res = await get(base, path, "application/json");
      strictEqual(res.status, 400, path);
      strictEqual(res.contentType, JSON_CT, path);
      strictEqual(res.vary, "Accept", path);
      // TOG-6717 rides alongside the error code: this pin owns the filter
      // gate, not the envelope shape — strip the triage id, then assert it
      // is present and agrees with the header.
      const { requestId, ...body } = JSON.parse(res.text);
      strictEqual(body.error, "invalid_filter", path);
      strictEqual(body.kind, kind, path);
      strictEqual(body.value, value, path);
      ok(Array.isArray(body.valid) && body.valid.length > 0, `${path}: valid named`);
      ok(Array.isArray(body.errors) && body.errors.length > 0, `${path}: errors listed`);
      ok(/^[0-9a-f]{32}$/.test(requestId ?? ""), `${path}: requestId is 32 lowercase hex`);
      strictEqual(requestId, res.requestIdHeader, `${path}: header and body agree`);
    }
  });

  it("returns offset-past-end as a 200 JSON empty page with the intact total", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await get(base, "/listings?offset=999", "application/json");
    strictEqual(res.status, 200);
    strictEqual(res.contentType, JSON_CT);
    const body = JSON.parse(res.text);
    deepStrictEqual(body.listings, []);
    strictEqual(body.total, 3, "full stub match count kept");
    strictEqual(body.offset, 999);
  });

  it("keeps HTML the default and JSON on combined negotiation", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const accept of [undefined, "text/html"]) {
      const res = await get(base, "/listings?q=zzz-no-such-listing", accept);
      strictEqual(res.status, 200, `accept=${accept}`);
      strictEqual(res.contentType, HTML_CT, `accept=${accept}`);
      strictEqual(res.vary, "Accept", `accept=${accept}`);
      ok(res.text.includes("No listings match these filters."), `accept=${accept}`);
    }
    // A client negotiating both stays on JSON (the shell fetch contract).
    const both = await get(base, "/listings?q=zzz-no-such-listing", "text/html,application/json");
    strictEqual(both.status, 200);
    strictEqual(both.contentType, JSON_CT);
    deepStrictEqual(JSON.parse(both.text).listings, []);
  });
});
