// Request id on JSON errors (TOG-6717, gap R4-11 from TOG-6636).
//
// JSON error bodies carried no correlation id, so staging triage could not
// match a response to logs. Contract pinned here:
//   - every JSON error (4xx/5xx via `sendJson`, the `sendMethodNotAllowed`
//     405 helper, and the inline 429 refusal) carries an `x-request-id`
//     response header and echoes the same value as `requestId` in the body;
//   - the id is 128-bit hex (32 lowercase hex chars), crypto-random:
//     two error responses carry distinct ids;
//   - header and body always agree on the same request;
//   - success JSON (2xx) carries no id — error-only scope.
//
// node:test, zero dependencies.

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp, REQUEST_ID_HEADER } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

describe("request id on JSON errors (TOG-6717)", () => {
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

  // Reads one error response as { status, header, body }.
  async function fetchError(base, path, init) {
    const res = await fetch(`${base}${path}`, init);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      header: res.headers.get(REQUEST_ID_HEADER),
      body: await res.json(),
    };
  }

  // Asserts the triage contract on one error response: header present and
  // hex-shaped, body echoes the same id alongside its own error fields.
  function assertRequestId(reply, where, expectedKeys) {
    strictEqual(reply.contentType, JSON_CT, `${where}: JSON content type`);
    ok(REQUEST_ID_RE.test(reply.header ?? ""), `${where}: x-request-id is 32 lowercase hex`);
    strictEqual(reply.body.requestId, reply.header, `${where}: header and body agree`);
    deepStrictEqual(
      Object.keys(reply.body).sort(),
      [...expectedKeys, "requestId"].sort(),
      `${where}: body is the error fields plus requestId, nothing else`,
    );
  }

  it("stamps distinct ids on fallback 404s, helper 405s, and the direct 405", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const first = await fetchError(base, "/nope");
    strictEqual(first.status, 404, "fallback 404: status");
    assertRequestId(first, "fallback 404", ["error"]);
    strictEqual(first.body.error, "not_found", "fallback 404: error field intact");
    // Two error responses carry distinct ids (acceptance).
    const second = await fetchError(base, "/nope");
    strictEqual(second.status, 404, "second 404: status");
    assertRequestId(second, "second 404", ["error"]);
    notStrictEqual(second.header, first.header, "two 404s carry distinct ids");
    // 405 via the shared helper carries Allow plus the id.
    const res = await fetch(`${base}/listings`, { method: "POST" });
    strictEqual(res.headers.get("allow"), "GET", "helper 405: Allow intact");
    strictEqual(res.headers.get(REQUEST_ID_HEADER) == null, false, "helper 405: header present");
    const helper = {
      status: res.status,
      contentType: res.headers.get("content-type"),
      header: res.headers.get(REQUEST_ID_HEADER),
      body: await res.json(),
    };
    strictEqual(helper.status, 405, "helper 405: status");
    assertRequestId(helper, "helper 405", ["error"]);
    // Direct 405 (the seller-confirm route bypasses the helper) matches too.
    const direct = await fetchError(base, "/sellers/submissions/northstar/nope/confirm", {
      method: "DELETE",
    });
    strictEqual(direct.status, 405, "direct 405: status");
    assertRequestId(direct, "direct 405", ["error"]);
    notStrictEqual(direct.header, first.header, "direct 405 id differs from the 404");
  });

  it("stamps the id on the 429 refusal and the purchase 403/404s", async () => {
    const stubLimiter = { check: () => ({ allowed: false, retryAfterSec: 42 }) };
    const limited = await start({ WAYSELECT_PREVIEW: "1" }, { rateLimiter: stubLimiter });
    const refused = await fetchError(limited, "/listings");
    strictEqual(refused.status, 429, "429: status");
    strictEqual(refused.body.retryAfterSec, 42, "429: retryAfterSec intact");
    assertRequestId(refused, "429", ["error", "retryAfterSec"]);
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // 403 keeps its refusal copy and gains the id.
    const denial = await fetchError(base, "/listings/northstar/alpha-chat/purchase", {
      method: "POST",
    });
    strictEqual(denial.status, 403, "403: status");
    strictEqual(
      denial.body.message,
      "Purchases are disabled in preview. No backend writes.",
      "403: message intact",
    );
    assertRequestId(denial, "403", ["error", "message"]);
    // 404 listing miss gains the id.
    const miss = await fetchError(base, "/listings/northstar/nope", {
      headers: { accept: "application/json" },
    });
    strictEqual(miss.status, 404, "listing miss: status");
    assertRequestId(miss, "listing miss", ["error"]);
  });

  it("stamps the id on seller-intake 400/413 and confirm 404s, not on success", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Body-gate 400 (wrong content type) gains the id.
    const wrongType = await fetchError(base, "/sellers/submissions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x=1",
    });
    strictEqual(wrongType.status, 400, "intake 400: status");
    assertRequestId(wrongType, "intake 400", ["error", "key", "source", "message"]);
    // Missing-intent confirm 404 gains the id with its routeId intact.
    const missing = await fetchError(base, "/sellers/submissions/northstar/nope/confirm");
    strictEqual(missing.status, 404, "confirm 404: status");
    strictEqual(missing.body.routeId, "northstar/nope", "confirm 404: routeId intact");
    assertRequestId(missing, "confirm 404", ["error", "routeId"]);
    // Success JSON (2xx) carries no id — error-only scope.
    const probe = await fetch(`${base}/healthz`);
    strictEqual(probe.status, 200, "healthz: status");
    strictEqual(probe.headers.get(REQUEST_ID_HEADER), null, "success: no request-id header");
    deepStrictEqual(Object.keys(await probe.json()).sort(), ["status", "version"], "success: no requestId field");
  });
});
