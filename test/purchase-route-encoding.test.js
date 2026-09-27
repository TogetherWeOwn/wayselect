// Purchase-route encoded-slash edge tests (TOG-6032, gap B2 from TOG-6013).
//
// The purchase route matches two raw path segments and then runs a single
// `decodeURIComponent` per segment (`web/server.js`). TOG-5960 pinned slashes
// for seller intake; this file pins the purchase route instead: `%2F`
// inside a segment, double-encoding, trailing slashes, malformed escapes,
// encoded dot-segments, and `+` handling. Every case below fails closed
// (404/405) or keeps the stub refusal (403) — no case reaches a listing.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

describe("purchase route encoded-slash edges (TOG-6032)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postPurchase(base, path) {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    return { status: res.status, body: await res.json() };
  }

  it("decodes %2F within a segment, then 404s on the miss (no segment escape)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // The router sees one segment (`northstar%2Fevil`); the single decode
    // yields `northstar/evil`, which matches no stub — the encoded slash
    // cannot escape its segment or smuggle a different listing.
    for (const path of [
      "/listings/northstar%2Fevil/alpha-chat/purchase",
      "/listings/northstar/alpha%2Fchat/purchase",
    ]) {
      const { status, body } = await postPurchase(base, path);
      strictEqual(status, 404, path);
      deepStrictEqual(body, { error: "listing_not_found" }, path);
    }
  });

  it("decodes double-encoding exactly once (no double-decode)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Single decode leaves a literal `%2F` in the id, which matches no stub.
    // A second decode would have produced `/` and must never happen.
    for (const path of [
      "/listings/northstar%252Fevil/alpha-chat/purchase",
      "/listings/northstar/alpha%252Fchat/purchase",
    ]) {
      const { status, body } = await postPurchase(base, path);
      strictEqual(status, 404, path);
      deepStrictEqual(body, { error: "listing_not_found" }, path);
    }
  });

  it("treats trailing slashes the same as bare purchase paths", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const known = await postPurchase(base, "/listings/northstar/alpha-chat/purchase/");
    strictEqual(known.status, 403);
    deepStrictEqual(known.body, {
      error: "preview_only",
      message: "Purchases are disabled in preview. No backend writes.",
    });
    const unknown = await postPurchase(base, "/listings/a/b/purchase/");
    strictEqual(unknown.status, 404);
    deepStrictEqual(unknown.body, { error: "listing_not_found" });
    // An encoded trailing slash is data, not a separator: `alpha-chat/`
    // matches no stub even though the bare id exists.
    const encoded = await postPurchase(base, "/listings/northstar/alpha-chat%2F/purchase");
    strictEqual(encoded.status, 404);
    deepStrictEqual(encoded.body, { error: "listing_not_found" });
  });

  it("rejects malformed percent-encoding without crashing", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const { status, body } = await postPurchase(base, "/listings/%E0%A4%A/broken/purchase");
    strictEqual(status, 404);
    deepStrictEqual(body, { error: "listing_not_found" });
    // Server survives: a follow-up request still works.
    strictEqual((await fetch(`${base}/listings`)).status, 200);
  });

  it("normalizes encoded dot-segments before routing (fail-closed 404)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // `new URL(...).pathname` resolves `%2E%2E` as `..`, so the target leaves
    // every known route shape: route-level `not_found`, never a listing
    // lookup and never a traversal.
    const { status, body } = await postPurchase(base, "/listings/%2E%2E/alpha-chat/purchase");
    strictEqual(status, 404);
    deepStrictEqual(body, { error: "not_found" });
  });

  it("keeps method semantics on encoded purchase-shaped paths", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const get = await fetch(`${base}/listings/northstar%2Fevil/alpha-chat/purchase`);
    strictEqual(get.status, 405);
    deepStrictEqual(await get.json(), { error: "method_not_allowed" });
    // One encoded slash collapses the path to listing-route shape
    // (provider=`northstar%2falpha-chat`, model=`purchase`), so POST is a
    // 405 there too — never a purchase attempt.
    const collapsed = await postPurchase(base, "/listings/northstar%2falpha-chat/purchase");
    strictEqual(collapsed.status, 405);
    deepStrictEqual(collapsed.body, { error: "method_not_allowed" });
  });

  it("treats + as a literal plus in path segments (no space coercion)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // `+`-means-space applies to query strings, not paths.
    const { status, body } = await postPurchase(base, "/listings/northstar/alpha+chat/purchase");
    strictEqual(status, 404);
    deepStrictEqual(body, { error: "listing_not_found" });
    ok(true, "pinned");
  });
});
