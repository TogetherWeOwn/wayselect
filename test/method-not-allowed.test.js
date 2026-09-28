// TOG-6364: 405 `Allow` header + method-consistency contract.
//
// RFC 9110 §15.5.6 requires a 405 response to carry an `Allow` header naming
// the methods the target supports. Every known route shape funnels through
// `sendMethodNotAllowed` (web/server.js); unknown paths stay 404 (no
// resource, no `Allow`). OPTIONS/PUT/DELETE behave the same on every route.
//
// node:test, zero dependencies.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const WRONG_METHODS = ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"];

describe("405 Allow header + method consistency (TOG-6364)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function request(base, path, method) {
    const res = await fetch(`${base}${path}`, { method });
    const text = await res.text();
    return {
      status: res.status,
      allow: res.headers.get("allow"),
      contentType: res.headers.get("content-type"),
      nosniff: res.headers.get("x-content-type-options"),
      text,
    };
  }

  function assertMethodNotAllowed(res, allow, where) {
    strictEqual(res.status, 405, where);
    strictEqual(res.allow, allow, `${where}: Allow header`);
    strictEqual(res.contentType, JSON_CT, `${where}: content-type`);
    strictEqual(res.nosniff, "nosniff", `${where}: security headers`);
    // TOG-6717 rides alongside the error code: this pin owns the routing
    // (status/Allow), not the envelope shape, so the triage id is stripped.
    const { requestId: _requestId, ...body } = JSON.parse(res.text);
    deepStrictEqual(body, { error: "method_not_allowed" }, where);
  }

  it("GET-only routes 405 with `Allow: GET` for every wrong method", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const routes = [
      "/healthz",
      "/favicon.ico",
      "/listings",
      "/listings/",
      "/listings/northstar/alpha-chat",
    ];
    for (const path of routes) {
      for (const method of WRONG_METHODS.filter((m) => m !== "GET")) {
        // POST/PUT/DELETE/OPTIONS/PATCH are all wrong on a GET route.
        const res = await request(base, path, method);
        assertMethodNotAllowed(res, "GET", `${method} ${path}`);
      }
    }
  });

  it("purchase route 405s with `Allow: POST` for every non-POST method", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const path = "/listings/northstar/alpha-chat/purchase";
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const res = await request(base, path, method);
      assertMethodNotAllowed(res, "POST", `${method} ${path}`);
    }
  });

  it("purchase 405 precedes the listing check (unknown listing, wrong method)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await request(base, "/listings/northstar/nope/purchase", "GET");
    assertMethodNotAllowed(res, "POST", "GET unknown purchase");
  });

  it("unknown paths stay 404 with no Allow header for any method", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of ["/nope", "/listings/northstar", "/healthz/"]) {
      for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
        const res = await request(base, path, method);
        strictEqual(res.status, 404, `${method} ${path}`);
        strictEqual(res.allow, null, `${method} ${path}: no Allow on 404`);
      }
    }
  });
});
