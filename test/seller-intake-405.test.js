// TOG-6707 (R4-01): seller-intake 405 carries `Allow: POST`.
//
// The intake branch in web/server.js previously answered wrong-method
// requests via raw `sendJson` with no `Allow` header; it now routes through
// the shared `sendMethodNotAllowed` helper like every other route, per
// RFC 9110 §15.5.6.
//
// node:test, zero dependencies.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

describe("seller-intake 405 Allow header (TOG-6707)", () => {
  const servers = [];
  async function start() {
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("wrong-method on /sellers/submissions 405s with `Allow: POST`", async () => {
    const base = await start();
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const res = await fetch(`${base}/sellers/submissions`, { method });
      const text = await res.text();
      strictEqual(res.status, 405, `${method} /sellers/submissions: status`);
      strictEqual(res.headers.get("allow"), "POST", `${method} /sellers/submissions: Allow`);
      strictEqual(res.headers.get("content-type"), JSON_CT, `${method} /sellers/submissions: content-type`);
      strictEqual(res.headers.get("x-content-type-options"), "nosniff", `${method} /sellers/submissions: nosniff`);
      // TOG-6717 rides alongside the error code: this pin owns the
      // routing (status/Allow), not the envelope shape.
      const { requestId: _requestId, ...body } = JSON.parse(text);
      deepStrictEqual(body, { error: "method_not_allowed" }, `${method} /sellers/submissions: body`);
    }
  });

  it("trailing-slash intake path behaves the same", async () => {
    const base = await start();
    const res = await fetch(`${base}/sellers/submissions/`, { method: "GET" });
    strictEqual(res.status, 405);
    strictEqual(res.headers.get("allow"), "POST");
    // TOG-6717 rides alongside the error code (see above).
    const { requestId: _slashRequestId, ...slashBody } = await res.json();
    deepStrictEqual(slashBody, { error: "method_not_allowed" });
  });
});
