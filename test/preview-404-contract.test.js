// Tests for the TOG-5714 preview 404 content-type contract.
//
// Contract (documented in web/server.js):
//   - Browser routes (index, detail incl. listing misses, flag-off pages):
//     HTML by default; JSON only on explicit `Accept: application/json`.
//   - API-shaped routes (purchase stub incl. 405s) and unparseable targets:
//     always JSON.
//   - Unknown paths (fallback): JSON `{error: "not_found"}` by default;
//     HTML only on explicit browser navigation (`Accept: text/html`
//     without `application/json`). `*/*` (fetch/curl defaults) gets JSON.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";
const JSON_CT = "application/json; charset=utf-8";

describe("preview 404 content-type contract (TOG-5714)", () => {
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

  it("serves browser routes as HTML by default, JSON only on negotiation", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Unknown listing, flag on: HTML by default and for text/html ...
    for (const accept of [undefined, "text/html"]) {
      const miss = await get(base, "/listings/northstar/nope", accept);
      strictEqual(miss.status, 404, `accept=${accept}`);
      strictEqual(miss.contentType, HTML_CT, `accept=${accept}`);
      ok(miss.text.includes("Listing not found"), `accept=${accept}`);
    }
    // ... JSON only for explicit fragment negotiation.
    const fragMiss = await get(base, "/listings/northstar/nope", "application/json");
    strictEqual(fragMiss.status, 404);
    strictEqual(fragMiss.contentType, JSON_CT);
    deepStrictEqual(JSON.parse(fragMiss.text), { error: "listing_not_found" });
    // A client negotiating both stays on JSON (the shell fetch contract).
    const both = await get(base, "/listings/northstar/nope", "text/html,application/json");
    strictEqual(both.status, 404);
    strictEqual(both.contentType, JSON_CT);
  });

  it("serves unknown paths as JSON by default, HTML only for browsers", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Default (no Accept) and */* (fetch/curl): JSON.
    for (const accept of [undefined, "*/*", "application/json"]) {
      const unknown = await get(base, "/nope", accept);
      strictEqual(unknown.status, 404, `accept=${accept}`);
      strictEqual(unknown.contentType, JSON_CT, `accept=${accept}`);
      deepStrictEqual(JSON.parse(unknown.text), { error: "not_found" }, `accept=${accept}`);
    }
    // Explicit browser navigation: HTML not-found page.
    const browser = await get(base, "/nope", "text/html");
    strictEqual(browser.status, 404);
    strictEqual(browser.contentType, HTML_CT);
    ok(browser.text.includes("Page not found"), "HTML fallback page");
    ok(browser.text.includes('href="/listings"'), "back-to-listings link");
    // Browser Accept header shape (no application/json): still HTML.
    const fullBrowser = await get(
      base,
      "/nope",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
    );
    strictEqual(fullBrowser.status, 404);
    strictEqual(fullBrowser.contentType, HTML_CT);
    // Partial listing paths are unknown paths too: JSON by default ...
    const partial = await get(base, "/listings/northstar", undefined);
    strictEqual(partial.status, 404);
    strictEqual(partial.contentType, JSON_CT);
    // ... HTML for explicit browser navigation.
    const partialBrowser = await get(base, "/listings/northstar", "text/html");
    strictEqual(partialBrowser.status, 404);
    strictEqual(partialBrowser.contentType, HTML_CT);
  });

  it("keeps API-shaped errors JSON regardless of Accept", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const accept of [undefined, "text/html"]) {
      const post = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
        method: "POST",
        headers: accept === undefined ? {} : { accept },
      });
      strictEqual(post.status, 403, `accept=${accept}`);
      strictEqual(post.headers.get("content-type"), JSON_CT, `accept=${accept}`);
      const get = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
        headers: accept === undefined ? {} : { accept },
      });
      strictEqual(get.status, 405, `accept=${accept}`);
      strictEqual(get.headers.get("content-type"), JSON_CT, `accept=${accept}`);
    }
  });

  it("keeps flag-off gating on HTML in both flag states", async () => {
    const on = await start({ WAYSELECT_PREVIEW: "1" });
    const onIndex = await get(on, "/listings", undefined);
    strictEqual(onIndex.status, 200);
    strictEqual(onIndex.contentType, HTML_CT);
    const off = await start({});
    for (const path of ["/listings", "/listings/northstar/alpha-chat"]) {
      const res = await get(off, path, undefined);
      strictEqual(res.status, 404, path);
      strictEqual(res.contentType, HTML_CT, path);
      ok(res.text.includes("Preview unavailable"), path);
    }
    // Unknown paths stay JSON even with the flag off.
    const unknown = await get(off, "/nope", undefined);
    strictEqual(unknown.status, 404);
    strictEqual(unknown.contentType, JSON_CT);
  });

  it("keeps malformed detail encoding on the HTML browser default", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const malformed = await get(base, "/listings/%E0%A4%A/broken", undefined);
    strictEqual(malformed.status, 404);
    strictEqual(malformed.contentType, HTML_CT);
  });

  it("serves unparseable targets as JSON 404 without crashing", async () => {
    const { connect } = await import("node:net");
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const raw = await new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write("GET //[invalid HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    ok(raw.split("\r\n")[0].includes("404"), "status 404");
    ok(
      raw.toLowerCase().includes("content-type: application/json"),
      "JSON content-type on unparseable target",
    );
    // Server survives.
    const after = await get(`http://127.0.0.1:${port}`, "/listings", undefined);
    strictEqual(after.status, 200);
  });
});
