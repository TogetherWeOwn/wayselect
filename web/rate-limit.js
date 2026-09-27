// Per-IP/per-route rate limiter for the Wayselect preview server (TOG-5563).
//
// Zero dependencies: fixed-window counters keyed by client IP + route bucket.
// Over-limit requests are refused with 429 + Retry-After (see web/server.js).
//
// NOTE: the client key is the direct TCP peer (req.socket.remoteAddress).
// X-Forwarded-For is deliberately ignored — it is client-controlled and would
// let a caller rotate identities. If the preview ever sits behind a proxy or a
// public URL, re-evaluate trusted-proxy handling before exposing it.

export const DEFAULT_RATE_LIMIT = Object.freeze({
  windowMs: 60_000,
  max: 120,
});

// Safety valve so the counter map cannot grow without bound.
const MAX_ENTRIES = 10_000;

export function createRateLimiter({ windowMs, max } = {}) {
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_RATE_LIMIT.windowMs;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_RATE_LIMIT.max;
  // key `${ip} ${bucket}` -> { count, resetAt }
  const counts = new Map();

  function prune(now) {
    for (const [key, entry] of counts) {
      if (now >= entry.resetAt) {
        counts.delete(key);
      }
    }
  }

  return {
    windowMs: window,
    max: limit,
    check(ip, bucket, now = Date.now()) {
      const key = `${ip ?? "unknown"} ${bucket}`;
      let entry = counts.get(key);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + window };
        counts.set(key, entry);
        if (counts.size > MAX_ENTRIES) {
          prune(now);
        }
      }
      if (entry.count >= limit) {
        const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      entry.count += 1;
      return { allowed: true, retryAfterSec: 0 };
    },
  };
}
