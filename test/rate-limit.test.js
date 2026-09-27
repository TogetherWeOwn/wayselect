// Tests for the TOG-5563 preview rate limiter: per-IP/per-route caps,
// 429 + Retry-After, window reset, and per-bucket isolation (node:test,
// zero dependencies).

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRateLimiter, DEFAULT_RATE_LIMIT } from "../web/rate-limit.js";
import { createApp } from "../web/server.js";

describe("rate limiter", () => {
  it("allows up to max requests per window then refuses with retry-after", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    strictEqual(limiter.check("1.2.3.4", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("1.2.3.4", "GET /listings", 1).allowed, true);
    const refused = limiter.check("1.2.3.4", "GET /listings", 2);
    strictEqual(refused.allowed, false);
    ok(refused.retryAfterSec >= 1);
  });

  it("resets the count when the window expires", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    strictEqual(limiter.check("1.2.3.4", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("1.2.3.4", "GET /listings", 500).allowed, false);
    strictEqual(limiter.check("1.2.3.4", "GET /listings", 1000).allowed, true);
  });

  it("isolates counters by IP and by route bucket", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 1).allowed, false);
    // Different IP gets its own budget.
    strictEqual(limiter.check("10.0.0.2", "GET /listings", 1).allowed, true);
    // Different route bucket gets its own budget.
    strictEqual(limiter.check("10.0.0.1", "GET /listings/:provider/:model", 1).allowed, true);
  });

  it("exposes sane defaults", () => {
    ok(DEFAULT_RATE_LIMIT.windowMs > 0);
    ok(DEFAULT_RATE_LIMIT.max > 0);
  });
});

describe("preview server rate limiting", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    return `http://localhost:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("returns 429 with Retry-After once the per-route cap is hit", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 2 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    const limited = await fetch(`${base}/listings`);
    strictEqual(limited.status, 429);
    ok(limited.headers.get("retry-after") !== null);
    strictEqual((await limited.json()).error, "rate_limited");
  });

  it("caps one route bucket without starving another", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    strictEqual((await fetch(`${base}/listings`)).status, 429);
    // Detail route has its own budget.
    strictEqual((await fetch(`${base}/listings/northstar/alpha-chat`)).status, 200);
  });
});
