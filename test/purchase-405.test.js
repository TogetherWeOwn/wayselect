// TOG-7294 (R5): purchase-route 405 carries `Allow: POST` (test-only).
//
// Purchase sibling of R4-01 (`test/seller-intake-405.test.js`, TOG-6707).
// The purchase branch in web/server.js already refuses wrong-method hits
// through the shared `sendMethodNotAllowed` helper (RFC 9110 §15.5.6); the
// shared TOG-6364 contract pins the happy path, and this file pins the
// edges it does not:
//
//   - every non-POST method on a known listing's purchase path 405s with
//     `Allow: POST` (status + Allow + content-type + nosniff + exact
//     `{error:"method_not_allowed"}` body);
//   - a trailing slash is the same route, not a different refusal;
//   - the 405 precedes the listing check: unknown listings 405 (not 404)
//     for every wrong method;
//   - the method gate precedes everything else: flag-off still 405s (the
//     purchase route is ungated by design — POST refuses 403/404 with the
//     flag off, so a wrong method must 405 there too).
//
// TOG-6717 rides alongside the error code (a `requestId` field on JSON
// errors): this pin owns the routing (status/Allow), not the envelope
// shape, so the triage id is stripped before the body assert — the test
// passes with and without it.
//
// node:test, zero dependencies.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const WRONG_METHODS = ["GET", "PUT", "DELETE", "OPTIONS", "PATCH"];
const KNOWN_PURCHASE = "/listings/northstar/alpha-chat/purchase";
const UNKNOWN_PURCHASE = "/listings/northstar/nope/purchase";

describe("purchase-route 405 Allow header (TOG-7294)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env ?? { WAYSELECT_PREVIEW: "1" });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function fetchPurchase(base, path, method) {
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

  function assertPurchaseMethodNotAllowed(res, where) {
    strictEqual(res.status, 405, `${where}: status`);
    strictEqual(res.allow, "POST", `${where}: Allow`);
    strictEqual(res.contentType, JSON_CT, `${where}: content-type`);
    strictEqual(res.nosniff, "nosniff", `${where}: nosniff`);
    // TOG-6717 rides alongside the error code (see header comment).
    const { requestId: _requestId, ...body } = JSON.parse(res.text);
    deepStrictEqual(body, { error: "method_not_allowed" }, `${where}: body`);
  }

  it("wrong-method on a known purchase path 405s with `Allow: POST`", async () => {
    const base = await start();
    for (const method of WRONG_METHODS) {
      const res = await fetchPurchase(base, KNOWN_PURCHASE, method);
      assertPurchaseMethodNotAllowed(res, `${method} ${KNOWN_PURCHASE}`);
    }
  });

  it("trailing-slash purchase path behaves the same", async () => {
    const base = await start();
    const res = await fetchPurchase(base, `${KNOWN_PURCHASE}/`, "GET");
    assertPurchaseMethodNotAllowed(res, `GET ${KNOWN_PURCHASE}/`);
  });

  it("405 precedes the listing check: unknown listings 405 for every wrong method", async () => {
    const base = await start();
    for (const method of WRONG_METHODS) {
      const res = await fetchPurchase(base, UNKNOWN_PURCHASE, method);
      assertPurchaseMethodNotAllowed(res, `${method} ${UNKNOWN_PURCHASE}`);
    }
  });

  it("method gate precedes the preview flag (flag-off still 405s)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "0" });
    for (const method of ["GET", "PUT"]) {
      const res = await fetchPurchase(base, KNOWN_PURCHASE, method);
      assertPurchaseMethodNotAllowed(res, `${method} ${KNOWN_PURCHASE} flag-off`);
    }
  });
});
