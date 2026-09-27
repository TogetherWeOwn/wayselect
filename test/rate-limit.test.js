// Tests for the TOG-5563 preview rate limiter: per-IP/per-route caps,
// 429 + Retry-After, window reset, and per-bucket isolation (node:test,
// zero dependencies).

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  MAX_BUCKETS,
  normalizeClientIp,
  resolveClientIp,
} from "../web/rate-limit.js";
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

  it("stays bounded under synthetic scanner load (TOG-5741)", () => {
    // 5x the cap of distinct IPs inside one window: live count never
    // exceeds the cap, and the limiter keeps answering.
    const cap = 200;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1_000_000, maxBuckets: cap });
    strictEqual(limiter.maxBuckets, cap);
    let allowed = 0;
    for (let i = 0; i < cap * 5; i += 1) {
      if (limiter.check(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`, "GET /listings", i).allowed) {
        allowed += 1;
      }
    }
    strictEqual(limiter.liveBucketCount(cap * 5), cap);
    // Every distinct IP was served exactly once: inserting past the cap
    // evicts a cold bucket instead of refusing the newcomer.
    strictEqual(allowed, cap * 5);
  });

  it("evicts the least-recently-used live bucket past the cap (TOG-5741)", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10, maxBuckets: 3 });
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("10.0.0.2", "GET /listings", 1).allowed, true);
    strictEqual(limiter.check("10.0.0.3", "GET /listings", 2).allowed, true);
    // Refresh 10.0.0.1 so 10.0.0.2 becomes the LRU victim.
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 3).allowed, true);
    strictEqual(limiter.check("10.0.0.4", "GET /listings", 4).allowed, true);
    strictEqual(limiter.liveBucketCount(4), 3);
    // The victim's count reset on eviction: it is served again, while the
    // refreshed hot key keeps its accumulated count.
    strictEqual(limiter.check("10.0.0.2", "GET /listings", 5).allowed, true);
    for (let i = 0; i < 8; i += 1) {
      limiter.check("10.0.0.1", "GET /listings", 6 + i);
    }
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 20).allowed, false);
  });

  it("prefers TTL eviction over LRU: expired buckets go first (TOG-5741)", () => {
    const limiter = createRateLimiter({ windowMs: 100, max: 1, maxBuckets: 2 });
    strictEqual(limiter.check("10.0.0.1", "GET /listings", 0).allowed, true);
    strictEqual(limiter.check("10.0.0.2", "GET /listings", 50).allowed, true);
    // At t=101 the 10.0.0.1 window (resetAt 100) is expired but 10.0.0.2
    // (resetAt 150) is live. The newcomer must reap the expired bucket,
    // not evict the live one.
    strictEqual(limiter.check("10.0.0.3", "GET /listings", 101).allowed, true);
    strictEqual(limiter.liveBucketCount(101), 2);
    // Proof the live bucket survived: its count is intact, so with max=1
    // it is refused. Had LRU evicted it, this would mint a fresh bucket
    // and allow.
    strictEqual(limiter.check("10.0.0.2", "GET /listings", 102).allowed, false);
  });

  it("exposes the default bucket cap (TOG-5741)", () => {
    ok(MAX_BUCKETS > 0);
    strictEqual(createRateLimiter().maxBuckets, MAX_BUCKETS);
    strictEqual(createRateLimiter({ maxBuckets: 0 }).maxBuckets, MAX_BUCKETS);
    strictEqual(createRateLimiter({ maxBuckets: 7 }).maxBuckets, 7);
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

describe("XFF trust boundary (TOG-6029)", () => {
  it("ignores XFF by default: untrusted peer keys on the direct peer", () => {
    strictEqual(resolveClientIp("192.0.2.10", "9.9.9.9"), "192.0.2.10");
    strictEqual(resolveClientIp("192.0.2.10", "9.9.9.9", null), "192.0.2.10");
    strictEqual(resolveClientIp("192.0.2.10", "9.9.9.9", ""), "192.0.2.10");
  });

  it("ignores XFF when the peer is not the trusted proxy (spoof-proof)", () => {
    strictEqual(resolveClientIp("192.0.2.10", "9.9.9.9", "10.0.0.1"), "192.0.2.10");
    strictEqual(resolveClientIp("192.0.2.99", "9.9.9.9", "192.0.2.10"), "192.0.2.99");
  });

  it("uses the leftmost XFF entry only when the peer is the trusted proxy", () => {
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9, 10.0.0.2", "10.0.0.1"), "9.9.9.9");
    // Single-hop only: later chain entries never become the client.
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9, 8.8.8.8", "10.0.0.1"), "9.9.9.9");
  });

  it("falls back to the peer on missing, empty, or garbage XFF", () => {
    strictEqual(resolveClientIp("10.0.0.1", undefined, "10.0.0.1"), "10.0.0.1");
    strictEqual(resolveClientIp("10.0.0.1", "", "10.0.0.1"), "10.0.0.1");
    strictEqual(resolveClientIp("10.0.0.1", "   ", "10.0.0.1"), "10.0.0.1");
    // Fail closed: garbage/hostname/injection first-entries mint no bucket.
    strictEqual(resolveClientIp("10.0.0.1", "garbage", "10.0.0.1"), "10.0.0.1");
    strictEqual(resolveClientIp("10.0.0.1", "evil.example.com", "10.0.0.1"), "10.0.0.1");
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9\nX-Injected: 1", "10.0.0.1"), "10.0.0.1");
  });

  it("normalizes both peer and trusted proxy before comparing", () => {
    // IPv4-mapped peer matches a plain-IPv4 trusted proxy entry.
    strictEqual(resolveClientIp("::ffff:10.0.0.1", "9.9.9.9", "10.0.0.1"), "9.9.9.9");
    // Case/zone-insensitive comparison on the trusted entry.
    strictEqual(resolveClientIp("FE80::1", "9.9.9.9", "fe80::1"), "9.9.9.9");
    // An "unknown" trusted entry never matches: fail closed to the peer.
    strictEqual(resolveClientIp("10.0.0.5", "9.9.9.9", ""), "10.0.0.5");
    // IPv6 client identities survive the trusted path intact.
    strictEqual(
      resolveClientIp("10.0.0.1", "2001:db8::7", "10.0.0.1"),
      "2001:db8::7",
    );
  });
});

describe("preview server rate limiting", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent. Pinning
    // 127.0.0.1 keeps the trust-boundary tests deterministic.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
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

  it("honors XFF identities only behind the configured trusted proxy (TOG-6029)", async () => {
    // The test client connects from localhost, so trusting 127.0.0.1 puts
    // the suite behind the (simulated) single proxy hop: distinct XFF
    // clients get distinct budgets instead of sharing the peer bucket.
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 }, trustedProxyIp: "127.0.0.1" },
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      200,
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      429,
    );
    // A different client behind the same trusted proxy keeps its own budget.
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "10.10.10.10" } }))
        .status,
      200,
    );
  });

  it("reads the trusted proxy from WAYSELECT_TRUSTED_PROXY_IP env (TOG-6029)", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1", WAYSELECT_TRUSTED_PROXY_IP: "127.0.0.1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "9.9.9.9" } })).status,
      200,
    );
    strictEqual(
      (await fetch(`${base}/listings`, { headers: { "x-forwarded-for": "10.10.10.10" } }))
        .status,
      200,
    );
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

  it("429 Retry-After header carries the exact limiter verdict (TOG-6033)", async () => {
    // Deterministic value pin: a stubbed verdict of 42s must surface
    // verbatim as both the `Retry-After` header and the body field, so a
    // regression that drops or rewrites the header fails here, not in prod.
    const stubLimiter = { check: () => ({ allowed: false, retryAfterSec: 42 }) };
    const server = createApp({ WAYSELECT_PREVIEW: "1" }, { rateLimiter: stubLimiter });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${server.address().port}`;
    const limited = await fetch(`${base}/listings`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("retry-after"), "42");
    const body = await limited.json();
    strictEqual(body.error, "rate_limited");
    strictEqual(body.retryAfterSec, 42);
  });

  it("every 429 under burst carries a matching Retry-After header (TOG-6033)", async () => {
    // Burst pin: once the cap is hit, each subsequent refusal — not just
    // the first — must carry a present, positive-integer `Retry-After`
    // header that matches its own `retryAfterSec` body field.
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    for (let i = 0; i < 5; i += 1) {
      const limited = await fetch(`${base}/listings`);
      strictEqual(limited.status, 429);
      const header = limited.headers.get("retry-after");
      ok(header !== null, `burst refusal ${i} must carry a Retry-After header`);
      const retryAfter = Number(header);
      ok(
        Number.isInteger(retryAfter) && retryAfter >= 1,
        `burst Retry-After must be a positive integer, got ${header}`,
      );
      strictEqual(
        (await limited.json()).retryAfterSec,
        retryAfter,
        `burst refusal ${i} header and body must agree`,
      );
    }
  });
});
