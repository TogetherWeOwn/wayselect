// Favicon route contract (TOG-6369, gap G8 from TOG-6346).
//
// `/favicon.ico` previously fell through to the TOG-5714 unknown-path 404
// JSON contract, so every browser page load emitted a 404 (log noise;
// behavior unpinned). This file pins the dedicated route (documented in
// web/server.js):
//   - GET → 204 No Content with an empty body and no content-type;
//     ungated by WAYSELECT_PREVIEW and exempt from rate limiting (every
//     page load requests it, like /healthz).
//   - Non-GET methods → 405 `{error: "method_not_allowed"}` with
//     `Allow: GET` per the TOG-6364 convention.
//   - Every response carries `nosniff`; non-HTML responses carry no
//     framing/CSP headers (the TOG-5731/TOG-6049 audit shape).
//
// node:test, zero dependencies.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const WRONG_METHODS = ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"];

describe("favicon route contract (TOG-6369)", () => {
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

  async function request(base, path, init) {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    return {
      status: res.status,
      allow: res.headers.get("allow"),
      contentType: res.headers.get("content-type"),
      nosniff: res.headers.get("x-content-type-options"),
      csp: res.headers.get("content-security-policy"),
      framing: res.headers.get("x-frame-options"),
      text,
    };
  }

  it("GET answers 204 with an empty body in both flag states", async () => {
    for (const env of [{ WAYSELECT_PREVIEW: "1" }, {}]) {
      const base = await start(env);
      // Browser icon fetches negotiate image types; an address-bar-style
      // navigation negotiates HTML. The 204 has no body, so Accept must not
      // change the answer (in particular it must not fall through to the
      // TOG-5714 HTML fallback).
      for (
        const accept of [
          undefined,
          "image/avif,image/webp,image/*,*/*;q=0.8",
          "text/html",
        ]
      ) {
        const init = accept === undefined ? undefined : { headers: { accept } };
        const res = await request(base, "/favicon.ico", init);
        strictEqual(res.status, 204, `flag=${JSON.stringify(env)} accept=${accept}`);
        strictEqual(res.text, "", "204 carries no body");
        strictEqual(res.contentType, null, "204 carries no content-type");
        strictEqual(res.nosniff, "nosniff", "every response carries nosniff");
        strictEqual(res.csp, null, "non-HTML responses carry no CSP");
        strictEqual(res.framing, null, "non-HTML responses carry no framing denial");
      }
      // Cache-busting query strings still hit the route (pathname match).
      const queried = await request(base, "/favicon.ico?v=2");
      strictEqual(queried.status, 204, "query string stays on the route");
    }
  });

  it("non-GET methods 405 with Allow: GET", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const method of WRONG_METHODS) {
      const res = await request(base, "/favicon.ico", { method });
      strictEqual(res.status, 405, method);
      strictEqual(res.allow, "GET", `${method}: Allow header`);
      strictEqual(res.contentType, JSON_CT, `${method}: content-type`);
      strictEqual(res.nosniff, "nosniff", `${method}: security headers`);
      deepStrictEqual(JSON.parse(res.text), { error: "method_not_allowed" }, method);
    }
  });

  it("answers 204 under a saturated limiter", async () => {
    // Budget of 1 per window: the first listing request passes, the second
    // is refused — but the favicon path answers before the limiter.
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await request(base, "/listings")).status, 200);
    strictEqual((await request(base, "/listings")).status, 429, "precondition: limiter must be saturated");
    strictEqual(
      (await request(base, "/favicon.ico")).status,
      204,
      "favicon answers before the limiter",
    );
  });

  it("trailing slash falls through to the unknown-path 404 contract", async () => {
    // A trailing slash is a different path: it keeps the TOG-5714 fallback
    // (JSON 404 by default), never a false-positive 204.
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await request(base, "/favicon.ico/");
    strictEqual(res.status, 404);
    strictEqual(res.contentType, JSON_CT);
    deepStrictEqual(JSON.parse(res.text), { error: "not_found" });
  });
});
