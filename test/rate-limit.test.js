// Tests for the TOG-5563 preview rate limiter: per-IP/per-route caps,
// 429 + Retry-After, window reset, and per-bucket isolation (node:test,
// zero dependencies).

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createRateLimiter, DEFAULT_RATE_LIMIT, normalizeClientIp } from "../web/rate-limit.js";
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

  it("normalizes IPv6 textual variants to one client identity", () => {
    // IPv4-mapped form (what Node reports for IPv4 peers on dual-stack
    // sockets) must share the plain IPv4 budget.
    strictEqual(normalizeClientIp("::ffff:127.0.0.1"), "127.0.0.1");
    strictEqual(normalizeClientIp("::FFFF:10.0.0.1"), "10.0.0.1");
    strictEqual(normalizeClientIp("::ffff:0:192.168.1.9"), "192.168.1.9");
    // Hex case and %zone scopes are cosmetic, not new identities.
    strictEqual(normalizeClientIp("FE80::1"), "fe80::1");
    strictEqual(normalizeClientIp("fe80::1%eth0"), "fe80::1");
    // Genuine distinct addresses stay distinct.
    ok(normalizeClientIp("2001:db8::1") !== normalizeClientIp("2001:db8::2"));
    // Empty/unknown input collapses so it cannot bypass the cap.
    strictEqual(normalizeClientIp(""), "unknown");
    strictEqual(normalizeClientIp(undefined), "unknown");
  });

  it("shares one budget across IPv4 and IPv4-mapped IPv6 forms", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    strictEqual(limiter.check("127.0.0.1", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("::ffff:127.0.0.1", "GET /listings", 1).allowed, false);
  });

  it("characterizes burst behavior: exact retry-after and window-edge budget", () => {
    // retryAfterSec is the ceiling of remaining window seconds, min 1.
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    strictEqual(limiter.check("10.9.9.9", "GET /listings", 0).allowed, true);
    const refused = limiter.check("10.9.9.9", "GET /listings", 1500);
    strictEqual(refused.allowed, false);
    strictEqual(refused.retryAfterSec, 59);
    // Accepted risk: a fresh window grants a fresh budget even adjacent to
    // a saturated one (boundary burst up to 2x max). The cap bounds the
    // sustained rate, which is the threat that matters for this preview.
    strictEqual(limiter.check("10.9.9.9", "GET /listings", 60_000).allowed, true);
    strictEqual(limiter.check("10.9.9.9", "GET /listings", 60_001).allowed, false);
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

  it("ignores spoofed X-Forwarded-For: rotating it does not buy budget", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      200,
    );
    // A different spoofed identity on the same socket still hits the cap:
    // the key is the TCP peer, never the header.
    const spoofed = await fetch(`${base}/listings`, {
      headers: { "x-forwarded-for": "10.10.10.10, 9.9.9.9" },
    });
    strictEqual(spoofed.status, 429);
    strictEqual((await spoofed.json()).error, "rate_limited");
  });

  it("429 carries the security headers and an exact retry body", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    const limited = await fetch(`${base}/listings`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("x-content-type-options"), "nosniff");
    strictEqual(limited.headers.get("referrer-policy"), "no-referrer");
    const retryAfter = Number(limited.headers.get("retry-after"));
    ok(Number.isInteger(retryAfter) && retryAfter >= 1);
    strictEqual((await limited.json()).retryAfterSec, retryAfter);
  });
});
