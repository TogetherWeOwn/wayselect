// Tests for TOG-6711 (round-4 gap R4-05): uppercase provider/model path
// segments contract (test-only). Route ids are lowercase slugs and
// `getStubListing` matches with exact `===`, so an uppercase URL never
// remaps to the lowercase listing — it 404s. These tests pin that: the
// exact `/listings/Northstar/Alpha-Chat` path 404s (HTML miss page by
// default, JSON `{error: "listing_not_found"}` on fragment negotiation),
// every other case variant behaves the same, and the lowercase canonical
// path still serves 200.
//
// node:test, zero dependencies.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";
const JSON_CT = "application/json; charset=utf-8";

describe("uppercase provider/model path segments (TOG-6711)", () => {
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
      text,
    };
  }

  it("404s /listings/Northstar/Alpha-Chat instead of remapping to lowercase", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Browser default: HTML listing-miss page echoing the requested segments.
    const miss = await get(base, "/listings/Northstar/Alpha-Chat", undefined);
    strictEqual(miss.status, 404);
    strictEqual(miss.contentType, HTML_CT);
    ok(miss.text.includes("Listing not found"), "miss page heading");
    ok(miss.text.includes("Northstar/Alpha-Chat"), "echoes requested casing");
    ok(!miss.text.includes("Alpha Chat"), "no silent remap to the listing");
    // Fragment negotiation: JSON miss payload.
    const frag = await get(base, "/listings/Northstar/Alpha-Chat", "application/json");
    strictEqual(frag.status, 404);
    strictEqual(frag.contentType, JSON_CT);
    // TOG-6717 (#166) adds a per-response requestId to every JSON error.
    const { requestId, ...payload } = JSON.parse(frag.text);
    match(requestId ?? "", /^[0-9a-f]{32}$/, "requestId on JSON miss");
    deepStrictEqual(payload, { error: "listing_not_found" });
  });

  it("404s every case variant while the lowercase path serves 200", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of [
      "/listings/NORTHSTAR/ALPHA-CHAT",
      "/listings/northstar/Alpha-Chat",
      "/listings/Northstar/alpha-chat",
    ]) {
      const res = await get(base, path, undefined);
      strictEqual(res.status, 404, path);
      strictEqual(res.contentType, HTML_CT, path);
    }
    const canonical = await get(base, "/listings/northstar/alpha-chat", undefined);
    strictEqual(canonical.status, 200);
    strictEqual(canonical.contentType, HTML_CT);
    ok(canonical.text.includes("Alpha Chat"), "canonical listing renders");
  });
});
