// TOG-8636: consolidated `Allow`-header audit across every 405 route.
//
// TOG-7671 covers the seller-confirm shape only; purchase + seller-intake
// were pinned separately (TOG-7294 `test/purchase-405.test.js`, TOG-6707
// `test/seller-intake-405.test.js`) and the shared contract lives in
// TOG-6364 (`test/method-not-allowed.test.js`) + TOG-6709
// (`test/head-method-contract.test.js`). This file is the single audit that
// names every 405 route shape in one table so a future route cannot lose its
// `Allow` header silently: RFC 9110 §15.5.6 requires every 405 to carry
// `Allow` naming the methods the target supports.
//
// Audit result (verified against web/server.js): the only runtime 405 writer
// is `sendMethodNotAllowed` (web/server.js:263); every known route shape
// funnels through it, unknown paths stay 404 with no `Allow`.
//
// Pinned here (flag on; method gate precedes the flag gate for every shape
// except seller-confirm, whose flag check runs first):
//   - GET-only: /healthz, /favicon.ico, /listings, /listings/,
//     /listings/:provider/:model (known AND unknown) -> `Allow: GET`
//   - purchase: /listings/:provider/:model/purchase (known, unknown, and
//     trailing-slash) -> `Allow: POST`, 405 precedes the listing check
//   - intake: /sellers/submissions (+ trailing slash) -> `Allow: POST`
//   - confirm: /sellers/submissions/:provider/:model/confirm ->
//     `Allow: GET, POST`
//   - unknown paths: 404 with no `Allow` header for any method
//
// node:test, zero dependencies.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

// [path, expected Allow] for every known 405 route shape.
const ALLOW_TABLE = [
  ["/healthz", "GET"],
  ["/favicon.ico", "GET"],
  ["/listings", "GET"],
  ["/listings/", "GET"],
  ["/listings/northstar/alpha-chat", "GET"],
  ["/listings/northstar/nope", "GET"],
  ["/listings/northstar/alpha-chat/purchase", "POST"],
  ["/listings/northstar/nope/purchase", "POST"],
  ["/listings/northstar/alpha-chat/purchase/", "POST"],
  ["/sellers/submissions", "POST"],
  ["/sellers/submissions/", "POST"],
  ["/sellers/submissions/northstar/seller-chat/confirm", "GET, POST"],
];

const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];

function wrongMethodsFor(allow) {
  const allowed = allow.split(",").map((m) => m.trim());
  return ALL_METHODS.filter((m) => !allowed.includes(m));
}

describe("Allow-header audit across all 405 routes (TOG-8636)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env ?? { WAYSELECT_PREVIEW: "1" });
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
    strictEqual(res.status, 405, `${where}: status`);
    strictEqual(res.allow, allow, `${where}: Allow`);
    strictEqual(res.contentType, JSON_CT, `${where}: content-type`);
    strictEqual(res.nosniff, "nosniff", `${where}: nosniff`);
    // TOG-6717 rides alongside the error code: this audit owns the routing
    // (status/Allow), not the envelope shape, so the triage id is stripped.
    const { requestId: _requestId, ...body } = JSON.parse(res.text);
    deepStrictEqual(body, { error: "method_not_allowed" }, `${where}: body`);
  }

  it("every known route shape 405s with its documented Allow value", async () => {
    const base = await start();
    for (const [path, allow] of ALLOW_TABLE) {
      for (const method of wrongMethodsFor(allow)) {
        const res = await request(base, path, method);
        assertMethodNotAllowed(res, allow, `${method} ${path}`);
      }
    }
  });

  it("purchase 405 precedes the listing check (unknown listing, wrong method)", async () => {
    const base = await start();
    const res = await request(base, "/listings/northstar/nope/purchase", "GET");
    assertMethodNotAllowed(res, "POST", "GET unknown purchase");
  });

  it("HEAD is a wrong method on every known shape (Allow pinned, body stripped)", async () => {
    // TOG-6709 pins the full HEAD contract; this audit only re-pins the
    // status + Allow per shape so the table stays the single source of
    // truth for which Allow value each route carries.
    const base = await start();
    for (const [path, allow] of ALLOW_TABLE) {
      const res = await fetch(`${base}${path}`, { method: "HEAD" });
      const text = await res.text();
      strictEqual(res.status, 405, `HEAD ${path}: status`);
      strictEqual(res.headers.get("allow"), allow, `HEAD ${path}: Allow`);
      strictEqual(text, "", `HEAD ${path}: no body on HEAD`);
    }
  });

  it("unknown paths stay 404 with no Allow header for any method", async () => {
    const base = await start();
    for (const path of ["/nope", "/listings/northstar", "/healthz/"]) {
      for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
        const res = await request(base, path, method);
        strictEqual(res.status, 404, `${method} ${path}`);
        strictEqual(res.allow, null, `${method} ${path}: no Allow on 404`);
      }
    }
  });
});
