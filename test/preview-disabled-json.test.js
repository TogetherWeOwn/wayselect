// Preview-disabled JSON fragment contract (TOG-6375, gap B2 from TOG-6346).
//
// Flag-off HTML shows the disabled page, but the shell's inline fragment
// fetch (`Accept: application/json`) had no pinned contract with the flag
// off: it received the HTML disabled page, so `res.json()` broke instead of
// rendering the shell's alert panel. This file pins the contract
// (documented in web/server.js):
//   - detail + JSON negotiation + flag off → 404 `{error:"preview_disabled"}`
//     with the JSON content-type, for known and unknown listings alike
//     (the flag gate runs before listing lookup);
//   - detail without negotiation + flag off → 404 HTML disabled page
//     (unchanged);
//   - index + flag off stays HTML-only even under JSON negotiation: the
//     index has no fragment shape, flag-on or flag-off.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";
const JSON_CT = "application/json; charset=utf-8";

describe("preview-disabled JSON fragment contract (TOG-6375)", () => {
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

  it("returns 404 preview_disabled JSON for fragment fetches with the flag off", async () => {
    const base = await start({});
    // Known and unknown listings gate identically: the flag check precedes
    // listing lookup, so an unknown id never leaks a different shape.
    for (const path of ["/listings/northstar/alpha-chat", "/listings/northstar/nope"]) {
      const res = await get(base, path, "application/json");
      strictEqual(res.status, 404, path);
      strictEqual(res.contentType, JSON_CT, path);
      deepStrictEqual(JSON.parse(res.text), { error: "preview_disabled" }, path);
    }
  });

  it("keeps JSON on the combined Accept shape the shell contract uses", async () => {
    // A client negotiating both stays on JSON (same rule as the TOG-5714
    // fragment-miss contract on the flag-on path).
    const base = await start({});
    const res = await get(base, "/listings/northstar/alpha-chat", "text/html,application/json");
    strictEqual(res.status, 404);
    strictEqual(res.contentType, JSON_CT);
    deepStrictEqual(JSON.parse(res.text), { error: "preview_disabled" });
  });

  it("keeps the HTML disabled page as the flag-off default", async () => {
    const base = await start({});
    // Default (no Accept), explicit browser navigation, and `*/*`
    // (fetch/curl defaults) all stay on the HTML disabled page.
    for (const accept of [undefined, "text/html", "*/*"]) {
      const res = await get(base, "/listings/northstar/alpha-chat", accept);
      strictEqual(res.status, 404, `accept=${accept}`);
      strictEqual(res.contentType, HTML_CT, `accept=${accept}`);
      ok(res.text.includes("Preview unavailable"), `accept=${accept}`);
      ok(res.text.includes("WAYSELECT_PREVIEW"), `accept=${accept}`);
    }
  });

  it("keeps the flag-off index HTML-only even under JSON negotiation", async () => {
    // Deliberate asymmetry: the index has no fragment shape (flag-on
    // ignores Accept and always renders HTML), so flag-off does too.
    const base = await start({});
    const res = await get(base, "/listings", "application/json");
    strictEqual(res.status, 404);
    strictEqual(res.contentType, HTML_CT);
    ok(res.text.includes("Preview unavailable"), "index has no fragment shape");
  });

  it("leaves flag-on fragment behavior unchanged", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const frag = await get(base, "/listings/northstar/alpha-chat", "application/json");
    strictEqual(frag.status, 200);
    ok(JSON.parse(frag.text).html.includes("<h1>Alpha Chat</h1>"), "fragment content");
    const miss = await get(base, "/listings/northstar/nope", "application/json");
    strictEqual(miss.status, 404);
    deepStrictEqual(JSON.parse(miss.text), { error: "listing_not_found" });
  });
});
