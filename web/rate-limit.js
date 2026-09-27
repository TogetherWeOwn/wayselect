// Per-IP/per-route rate limiter for the Wayselect preview server (TOG-5563).
//
// Zero dependencies: fixed-window counters keyed by client IP + route bucket.
// Over-limit requests are refused with 429 + Retry-After (see web/server.js).
//
// NOTE: the client key is the direct TCP peer (req.socket.remoteAddress).
// X-Forwarded-For is deliberately ignored — it is client-controlled and would
// let a caller rotate identities. Re-evaluate only if the preview ever sits
// behind a reverse proxy or a public URL: then key on X-Forwarded-For solely
// from a configured allowlist of trusted proxy peer IPs (never uncondition-
// ally), and treat a missing/untrusted peer as the direct TCP peer.
//
// Accepted risk (TOG-5732 audit): fixed-window counters admit a boundary
// burst of up to 2x max across a window edge (max at the end of window N
// plus max at the start of window N+1). A sliding-window log would close
// it, but is disproportionate for a localhost preview stub; the per-route
// caps bound sustained rate, which is the threat that matters here.

export const DEFAULT_RATE_LIMIT = Object.freeze({
  windowMs: 60_000,
  max: 120,
});

// Safety valve so the counter map cannot grow without bound.
const MAX_ENTRIES = 10_000;

// Canonicalize a client identity so one peer cannot hold several budgets
// (TOG-5732 audit). Textual variants of the same address — IPv4-mapped
// IPv6 (`::ffff:1.2.3.4`, which Node reports for IPv4 peers on dual-stack
// sockets), hex case, and `%zone` scopes — must share one bucket. Unknown
// or empty input collapses to "unknown" so it cannot bypass the cap.
export function normalizeClientIp(raw) {
  let ip = String(raw ?? "").trim().toLowerCase();
  if (ip === "") {
    return "unknown";
  }
  // Strip a %zone scope id (link-local `fe80::1%eth0`): the zone is an
  // interface label, not part of the peer identity.
  const zoneIndex = ip.indexOf("%");
  if (zoneIndex !== -1) {
    ip = ip.slice(0, zoneIndex);
    if (ip === "") {
      return "unknown";
    }
  }
  // Unmap IPv4-mapped / IPv4-translated IPv6 forms to the IPv4 address so
  // `127.0.0.1` and `::ffff:127.0.0.1` share one budget. The more specific
  // translated form is checked first: the general pattern would otherwise
  // match it with a non-IPv4 capture and fall through unmapped.
  const mapped = ip.match(/^::ffff:0:(.+)$/) ?? ip.match(/^::ffff:(.+)$/);
  if (mapped) {
    const v4 = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
      return v4;
    }
  }
  return ip;
}

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
      const key = `${normalizeClientIp(ip)} ${bucket}`;
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
