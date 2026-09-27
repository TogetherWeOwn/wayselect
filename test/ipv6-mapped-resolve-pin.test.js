// IPv6-mapped IPv4 normalization pin (TOG-6371, gap G10/S2).
//
// TOG-6028 pinned loopback bucketing and TOG-6029 pinned the XFF trust
// boundary, but the IPv6-mapped equivalence inside `resolveClientIp`
// (web/rate-limit.js) was unpinned: without this test, `10.0.0.1` and
// `::ffff:10.0.0.1` as trusted-proxy entries or XFF client identities could
// silently diverge into two rate-limit buckets for one client. Every
// assertion below passes against current behavior; a regression that drops
// the normalization fails here, not in prod. Zero dependencies,
// node:test only.

import { strictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter, resolveClientIp } from "../web/rate-limit.js";

describe("IPv6-mapped IPv4 normalization pin (TOG-6371)", () => {
  it("matches the trusted proxy regardless of mapped form", () => {
    // Mapped peer against a plain trusted entry, and plain peer against a
    // mapped trusted entry, must both enter the trusted path.
    strictEqual(resolveClientIp("::ffff:10.0.0.1", "9.9.9.9", "10.0.0.1"), "9.9.9.9");
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9", "::ffff:10.0.0.1"), "9.9.9.9");
    // Case-insensitive hex and the translated form compare equal too.
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9", "::FFFF:10.0.0.1"), "9.9.9.9");
    strictEqual(resolveClientIp("10.0.0.1", "9.9.9.9", "::ffff:0:10.0.0.1"), "9.9.9.9");
    // Loopback pair from TOG-6028: the mapped loopback peer is the trusted
    // 127.0.0.1 proxy, not a second identity.
    strictEqual(resolveClientIp("::ffff:127.0.0.1", "9.9.9.9", "127.0.0.1"), "9.9.9.9");
    strictEqual(resolveClientIp("127.0.0.1", "9.9.9.9", "::ffff:127.0.0.1"), "9.9.9.9");
  });

  it("resolves mapped XFF client identities to the plain IPv4 form", () => {
    const plain = resolveClientIp("10.0.0.1", "9.9.9.9", "10.0.0.1");
    strictEqual(plain, "9.9.9.9");
    // Every mapped spelling of the same client resolves identically, so no
    // spelling gets its own bucket.
    strictEqual(resolveClientIp("10.0.0.1", "::ffff:9.9.9.9", "10.0.0.1"), plain);
    strictEqual(resolveClientIp("10.0.0.1", "::FFFF:9.9.9.9", "10.0.0.1"), plain);
    strictEqual(resolveClientIp("10.0.0.1", "::ffff:0:9.9.9.9", "10.0.0.1"), plain);
    strictEqual(resolveClientIp("10.0.0.1", "  ::ffff:9.9.9.9  ", "10.0.0.1"), plain);
    strictEqual(resolveClientIp("127.0.0.1", "::ffff:9.9.9.9", "127.0.0.1"), plain);
  });

  it("shares one limiter budget across plain and mapped XFF identities", () => {
    // The two-buckets failure mode, end to end through the resolved client
    // key: spend the budget as plain, replay as mapped, expect refusal.
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    const first = resolveClientIp("10.0.0.1", "9.9.9.9", "10.0.0.1");
    const replay = resolveClientIp("10.0.0.1", "::ffff:9.9.9.9", "10.0.0.1");
    strictEqual(limiter.check(first, "GET /listings", 0).allowed, true);
    strictEqual(limiter.check(replay, "GET /listings", 1).allowed, false);
    // And the reverse order: mapped first, plain replay.
    const reverse = createRateLimiter({ windowMs: 60_000, max: 1 });
    strictEqual(reverse.check(replay, "GET /listings", 0).allowed, true);
    strictEqual(reverse.check(first, "GET /listings", 1).allowed, false);
  });

  it("normalizes a mapped direct peer with no proxy configured", () => {
    // Default path (XFF ignored): a dual-stack peer reporting the mapped
    // form keys on the plain address, never a parallel bucket.
    strictEqual(resolveClientIp("::ffff:192.0.2.10", "9.9.9.9"), "192.0.2.10");
    strictEqual(resolveClientIp("::ffff:192.0.2.10", "9.9.9.9", null), "192.0.2.10");
  });

  it("does not collapse non-IPv4 mapped-like forms or genuine IPv6", () => {
    // Guard against over-normalization: only dotted-quad tails unmap.
    ok(resolveClientIp("10.0.0.1", "9.9.9.9", "10.0.0.1") !== "2001:db8::7");
    strictEqual(
      resolveClientIp("10.0.0.1", "2001:db8::7", "10.0.0.1"),
      "2001:db8::7",
    );
    strictEqual(
      resolveClientIp("10.0.0.1", "::ffff:2001:db8::7", "10.0.0.1"),
      "::ffff:2001:db8::7",
    );
  });
});
