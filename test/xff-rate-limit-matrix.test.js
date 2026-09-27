// XFF/proxy rate-limit matrix (TOG-6046, gap T2 from TOG-6013).
//
// One named matrix pinning the four proxy postures end to end at the HTTP
// layer against `web/server.js` + `web/rate-limit.js` (unit coverage for
// `resolveClientIp` lives in test/rate-limit.test.js; this file pins the
// server wiring: peer keying, trusted-proxy opt-in, chain handling, and
// spoof resistance). Zero dependencies, node:test only.
//
// Rows:
//   1. direct (no proxy) .......... XFF ignored, key is the TCP peer.
//   2. single trusted hop ......... distinct XFF clients get distinct budgets.
//   3. multi-hop chain ............ leftmost XFF entry wins; tail ignored.
//   4. spoofed header ............. rotating XFF buys no budget; garbage
//                                   fails closed to the peer.
// Every row passes against the TOG-6029 behavior; a regression fails here.

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

describe("XFF rate-limit matrix (TOG-6046)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent. Pinning
    // 127.0.0.1 keeps the trust-boundary rows deterministic.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("row 1 — direct: XFF is ignored, the TCP peer owns the bucket", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      200,
    );
    // Same socket, different claimed identity: still the peer's bucket.
    const second = await fetch(`${base}/listings`, {
      headers: { "x-forwarded-for": "10.10.10.10" },
    });
    strictEqual(second.status, 429);
    strictEqual((await second.json()).error, "rate_limited");
  });

  it("row 2 — single trusted hop: distinct XFF clients get distinct budgets", async () => {
    // The test client connects from localhost, so trusting 127.0.0.1 puts
    // the suite behind the (simulated) single proxy hop.
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 }, trustedProxyIp: "127.0.0.1" },
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      200,
    );
    // Same client again: its own budget is spent.
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      429,
    );
    // A different client behind the same proxy keeps a fresh budget.
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "10.10.10.10" } }))
        .status,
      200,
    );
  });

  it("row 3 — multi-hop chain: leftmost entry wins, tail never mints a bucket", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 }, trustedProxyIp: "127.0.0.1" },
    );
    strictEqual(
      (
        await fetch(`${base}/listings`, {
          headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.2, 10.0.0.3" },
        })
      ).status,
      200,
    );
    // Same leftmost client with a rewritten tail: same bucket, refused.
    const replay = await fetch(`${base}/listings`, {
      headers: { "x-forwarded-for": "9.9.9.9, 192.0.2.99" },
    });
    strictEqual(replay.status, 429);
    strictEqual((await replay.json()).error, "rate_limited");
    // A tail entry from the first chain is not itself a client identity:
    // presenting it leftmost is a *different* client with its own budget.
    strictEqual(
      (
        await fetch(`${base}/listings`, {
          headers: { "x-forwarded-for": "10.0.0.2, 10.0.0.3" },
        })
      ).status,
      200,
    );
  });

  it("row 4 — spoofed header: rotating XFF buys no budget, garbage fails closed", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    // Rotating spoofed identities on the same socket: still the peer bucket.
    for (const spoof of ["9.9.9.9", "10.10.10.10, 9.9.9.9", "evil.example.com"]) {
      const res = await fetch(`${base}/listings`, {
        headers: { "x-forwarded-for": spoof },
      });
      strictEqual(res.status, 429, `spoofed XFF ${JSON.stringify(spoof)} must not buy budget`);
      strictEqual((await res.json()).error, "rate_limited");
      ok(res.headers.get("retry-after") !== null);
    }
  });
});
