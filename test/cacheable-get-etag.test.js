// Cacheable GET contract (TOG-6050): ETag + Cache-Control + 304.
//
// Fixture-deterministic success JSON gets a strong content-hash ETag and a
// short shared-cache window, with `If-None-Match` revalidation answering
// 304. Covered routes (all 200 only):
//   - GET /healthz (ungated; body constant per process)
//   - GET /listings with `Accept: application/json` (flag-on 200 result)
//   - GET /listings/:provider/:model fragment with `Accept: application/json`
// Out of scope (pinned elsewhere, asserted here as absent):
//   - HTML pages: per-response nonce CSP makes bodies non-deterministic.
//   - Error JSON: `no-store` (pinned in json-error-no-store.test.js).
//   - Seller confirm/receipt JSON: perishable intents + recordedAt stamps.
//   - Favicon 204: no body to hash.
//
// node:test, zero dependencies.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const CACHEABLE_CC = "public, max-age=60";
const ETAG_RE = /^"sha256-[A-Za-z0-9_-]{43}"$/;

describe("cacheable GET ETag / Cache-Control / 304 (TOG-6050)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function get(base, path, headers = {}) {
    const res = await fetch(`${base}${path}`, { headers });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      cacheControl: res.headers.get("cache-control"),
      etag: res.headers.get("etag"),
      vary: res.headers.get("vary"),
      nosniff: res.headers.get("x-content-type-options"),
      text,
    };
  }

  it("GET /healthz carries ETag + cacheable Cache-Control", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await get(base, "/healthz");
    strictEqual(res.status, 200);
    strictEqual(res.contentType, JSON_CT);
    strictEqual(res.cacheControl, CACHEABLE_CC);
    ok(ETAG_RE.test(res.etag ?? ""), `etag shape: ${res.etag}`);
    strictEqual(res.nosniff, "nosniff", "security headers intact");
  });

  it("answers 304 on a matching If-None-Match (exact and *)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const first = await get(base, "/healthz");
    for (const inm of [first.etag, "*", `W/${first.etag}`, `"other", ${first.etag}`]) {
      const res = await get(base, "/healthz", { "if-none-match": inm });
      strictEqual(res.status, 304, `If-None-Match: ${inm}`);
      strictEqual(res.text, "", "304 carries no body");
      strictEqual(res.etag, first.etag, "304 repeats the ETag");
      strictEqual(res.cacheControl, CACHEABLE_CC, "304 repeats Cache-Control");
    }
  });

  it("answers 200 on a stale If-None-Match", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await get(base, "/healthz", { "if-none-match": '"stale-tag"' });
    strictEqual(res.status, 200);
    ok(res.text.includes('"status":"ok"'), "full body on mismatch");
  });

  it("index JSON result carries ETag + 304; query changes the tag", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const empty = await get(base, "/listings?q=zzz-no-such-listing", {
      accept: "application/json",
    });
    strictEqual(empty.status, 200);
    strictEqual(empty.cacheControl, CACHEABLE_CC);
    ok(ETAG_RE.test(empty.etag ?? ""), `etag shape: ${empty.etag}`);
    strictEqual(empty.vary, "Accept", "Vary: Accept intact");
    const full = await get(base, "/listings", { accept: "application/json" });
    strictEqual(full.status, 200);
    ok(
      full.etag !== empty.etag,
      "different query results hash to different ETags",
    );
    const again = await get(
      base,
      "/listings?q=zzz-no-such-listing",
      { accept: "application/json" },
    );
    strictEqual(again.etag, empty.etag, "same query is deterministic");
    const revalidated = await get(base, "/listings?q=zzz-no-such-listing", {
      accept: "application/json",
      "if-none-match": empty.etag,
    });
    strictEqual(revalidated.status, 304);
    strictEqual(revalidated.text, "", "304 carries no body");
  });

  it("detail fragment carries ETag + 304; listings differ", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const alpha = await get(base, "/listings/northstar/alpha-chat", {
      accept: "application/json",
    });
    strictEqual(alpha.status, 200);
    strictEqual(alpha.cacheControl, CACHEABLE_CC);
    ok(ETAG_RE.test(alpha.etag ?? ""), `etag shape: ${alpha.etag}`);
    strictEqual(alpha.vary, "Accept", "Vary: Accept intact");
    const revalidated = await get(base, "/listings/northstar/alpha-chat", {
      accept: "application/json",
      "if-none-match": alpha.etag,
    });
    strictEqual(revalidated.status, 304);
    strictEqual(revalidated.etag, alpha.etag);
  });

  it("leaves HTML, errors, and transactional JSON without ETag", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // HTML pages: nonce CSP per response, never cacheable validators.
    for (const path of ["/listings", "/listings/northstar/alpha-chat"]) {
      const page = await get(base, path);
      strictEqual(page.status, 200, path);
      strictEqual(page.etag, null, `${path}: no ETag`);
      strictEqual(page.cacheControl, null, `${path}: no Cache-Control`);
    }
    // Invalid-filter 400: no-store error, no validators.
    const invalid = await get(base, "/listings?limit=abc", {
      accept: "application/json",
    });
    strictEqual(invalid.status, 400);
    strictEqual(invalid.cacheControl, "no-store");
    strictEqual(invalid.etag, null, "400: no ETag");
    // Fragment miss 404: no-store error, no validators.
    const miss = await get(base, "/listings/northstar/nope", {
      accept: "application/json",
    });
    strictEqual(miss.status, 404);
    strictEqual(miss.cacheControl, "no-store");
    strictEqual(miss.etag, null, "404: no ETag");
  });
});
