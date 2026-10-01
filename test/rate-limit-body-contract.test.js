// 429 body-shape contract (TOG-6376, gap B3 from TOG-6346).
//
// TOG-6033 pinned the `Retry-After` header; this file pins the body that
// goes with it (the 429 path in web/server.js):
//   - status 429 with the JSON content-type;
//   - body is exactly `{ error: "rate_limited", retryAfterSec, requestId }`
//     — no more, no fewer keys (`requestId` is the TOG-6717 triage id,
//     32 lowercase hex, echoed from the `x-request-id` header);
//   - `error` is the string "rate_limited";
//   - `retryAfterSec` is a positive integer and matches the `Retry-After`
//     header verbatim (`String(body.retryAfterSec)`).
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

describe("429 body shape contract (TOG-6376)", () => {
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

  it("pins the exact body against a stubbed verdict (deterministic)", async () => {
    // A stubbed verdict of 42s must surface verbatim as the header and as
    // the exact body object — an added, dropped, or retyped field fails
    // the deepStrictEqual below, not a prod client.
    const stubLimiter = { check: () => ({ allowed: false, retryAfterSec: 42 }) };
    const server = createApp({ WAYSELECT_PREVIEW: "1" }, { rateLimiter: stubLimiter });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const limited = await fetch(`${base}/listings`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("content-type"), JSON_CT);
    strictEqual(limited.headers.get("retry-after"), "42");
    const stubbed = await limited.json();
    strictEqual(stubbed.error, "rate_limited");
    strictEqual(stubbed.retryAfterSec, 42);
    ok(/^[0-9a-f]{32}$/.test(stubbed.requestId ?? ""), "requestId is 32 lowercase hex");
    strictEqual(
      limited.headers.get("x-request-id"),
      stubbed.requestId,
      "header and body agree",
    );
    deepStrictEqual(
      Object.keys(stubbed).sort(),
      ["error", "requestId", "retryAfterSec"],
      "no extra fields",
    );
  });

  it("pins keys, types, and header agreement on a live saturated limiter", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    const limited = await fetch(`${base}/listings`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("content-type"), JSON_CT);
    const body = await limited.json();
    deepStrictEqual(
      Object.keys(body).sort(),
      ["error", "requestId", "retryAfterSec"],
      "no extra fields",
    );
    strictEqual(body.error, "rate_limited");
    ok(/^[0-9a-f]{32}$/.test(body.requestId ?? ""), "requestId is 32 lowercase hex");
    ok(
      Number.isInteger(body.retryAfterSec) && body.retryAfterSec >= 1,
      `retryAfterSec must be a positive integer, got ${body.retryAfterSec}`,
    );
    strictEqual(
      limited.headers.get("retry-after"),
      String(body.retryAfterSec),
      "header and body must agree",
    );
  });
});
