// TOG-6709 (R4-03): HEAD method contract on GET routes.
//
// Gap: the TOG-6364 405 tests cover POST/PUT/DELETE/OPTIONS/PATCH but not
// HEAD. This pins what Node's http server actually does today: HEAD is just
// another wrong method on these routes — always 405 (never a HEAD-equivalent
// 200), with the body stripped by the HTTP layer, so only status + headers
// are asserted.
//
// Pinned behavior (flag on; method gate precedes the flag gate, so the
// flag-off column matches except where noted):
//   - GET-only routes (/healthz, /listings, /listings/, detail incl. misses):
//     405 with `Allow: GET` via sendMethodNotAllowed.
//   - Purchase route: 405 with `Allow: POST`.
//   - Seller intake route: 405 with `Allow: POST` via sendMethodNotAllowed
//     (TOG-6707). Seller confirm route: 405 with NO `Allow` header (still
//     answers via sendJson, not sendMethodNotAllowed) — pinned, not endorsed.
//   - Unknown paths: 404 with no `Allow` header.
//
// node:test, zero dependencies.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

describe("HEAD method contract (TOG-6709)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function head(base, path) {
    const res = await fetch(`${base}${path}`, { method: "HEAD" });
    return {
      status: res.status,
      allow: res.headers.get("allow"),
      contentType: res.headers.get("content-type"),
      nosniff: res.headers.get("x-content-type-options"),
      text: await res.text(),
    };
  }

  it("HEAD on GET-only routes is 405 with `Allow: GET` and an empty body", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const routes = [
      "/healthz",
      "/listings",
      "/listings/",
      "/listings?provider=northstar",
      "/listings/northstar/alpha-chat",
      "/listings/northstar/nope",
    ];
    for (const path of routes) {
      const res = await head(base, path);
      strictEqual(res.status, 405, `HEAD ${path}`);
      strictEqual(res.allow, "GET", `HEAD ${path}: Allow header`);
      strictEqual(res.contentType, JSON_CT, `HEAD ${path}: content-type`);
      strictEqual(res.nosniff, "nosniff", `HEAD ${path}: security headers`);
      strictEqual(res.text, "", `HEAD ${path}: no body on HEAD`);
    }
  });

  it("HEAD on the purchase route is 405 with `Allow: POST`", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await head(base, "/listings/northstar/alpha-chat/purchase");
    strictEqual(res.status, 405, "HEAD purchase");
    strictEqual(res.allow, "POST", "HEAD purchase: Allow header");
    strictEqual(res.contentType, JSON_CT, "HEAD purchase: content-type");
    strictEqual(res.nosniff, "nosniff", "HEAD purchase: security headers");
    strictEqual(res.text, "", "HEAD purchase: no body on HEAD");
  });

  it("HEAD on the seller intake route is 405 with `Allow: POST` (TOG-6707)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await head(base, "/sellers/submissions");
    strictEqual(res.status, 405, "HEAD /sellers/submissions");
    strictEqual(res.allow, "POST", "HEAD /sellers/submissions: Allow header");
    strictEqual(res.contentType, JSON_CT, "HEAD /sellers/submissions: content-type");
    strictEqual(res.nosniff, "nosniff", "HEAD /sellers/submissions: security headers");
    strictEqual(res.text, "", "HEAD /sellers/submissions: no body on HEAD");
  });

  it("HEAD on the seller confirm route is 405 with no `Allow` header (pinned as-is)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await head(base, "/sellers/submissions/x/y/confirm");
    strictEqual(res.status, 405, "HEAD confirm");
    strictEqual(res.allow, null, "HEAD confirm: no Allow header");
    strictEqual(res.contentType, JSON_CT, "HEAD confirm: content-type");
    strictEqual(res.nosniff, "nosniff", "HEAD confirm: security headers");
    strictEqual(res.text, "", "HEAD confirm: no body on HEAD");
  });

  it("HEAD on unknown paths stays 404 with no `Allow` header", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of ["/nope", "/listings/northstar", "/healthz/"]) {
      const res = await head(base, path);
      strictEqual(res.status, 404, `HEAD ${path}`);
      strictEqual(res.allow, null, `HEAD ${path}: no Allow on 404`);
      strictEqual(res.text, "", `HEAD ${path}: no body on HEAD`);
    }
  });

  it("HEAD method gate precedes the preview flag (flag-off still 405s)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "0" });
    for (const path of ["/listings", "/listings/northstar/alpha-chat"]) {
      const res = await head(base, path);
      strictEqual(res.status, 405, `HEAD ${path} flag-off`);
      strictEqual(res.allow, "GET", `HEAD ${path} flag-off: Allow header`);
      strictEqual(res.text, "", `HEAD ${path} flag-off: no body on HEAD`);
    }
  });
});
