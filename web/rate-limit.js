// Per-IP/per-route rate limiter for the Wayselect preview server (TOG-5563).
//
// Zero dependencies: fixed-window counters keyed by client IP + route bucket.
// Over-limit requests are refused with 429 + Retry-After (see web/server.js).
//
// NOTE: the client key is the direct TCP peer (req.socket.remoteAddress)
// by default. X-Forwarded-For is client-controlled and MUST NOT be trusted
// unless the direct peer is a proxy the operator explicitly configured (see
// resolveClientIp below). Never trust XFF unconditionally: behind no proxy
// it lets a caller rotate identities at will.
//
// TRUSTED-PROXY OPT-IN (TOG-6029): when the preview sits behind a single
// reverse proxy, set exactly one trusted proxy peer IP
// (`WAYSELECT_TRUSTED_PROXY_IP`, or `trustedProxyIp` in createApp options).
// Only then — and only when the direct TCP peer normalizes to that IP — is
// the leftmost X-Forwarded-For entry used as the client key. A missing or
// unparseable XFF falls back to the direct peer; an untrusted peer always
// keys on the direct peer, so spoofed XFF never evades the bucket.
// No production activation: the default is unset (direct-remote only).
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

// Eviction cap + policy (TOG-5741): the bucket map never holds more than
// MAX_BUCKETS entries (default 10_000; override per limiter via the
// `maxBuckets` option). Memory is therefore O(cap) no matter how many
// distinct IPs a scanner rotates through inside one window. On insert past
// the cap:
//   1. TTL first — sweep expired windows and drop them (freeing a bucket
//      costs nothing: its owner gets no fresh budget, the window is over).
//      The scan is bounded (see EVICT_SCAN_BUDGET) so a flood cannot turn
//      every insert into a full-map scan; leftovers are reaped by later
//      sweeps or overwritten on hit.
//   2. LRU second — if the sweep freed nothing, drop the
//      least-recently-used live bucket. Every live hit refreshes recency,
//      so a hot legitimate client is not evicted by cold scanner keys
//      while its window is live; evicting a live bucket resets its budget,
//      which is why TTL is preferred whenever an expired bucket exists.
export const MAX_BUCKETS = 10_000;

// Bound on the per-insert TTL scan: eviction work per insert is O(1), so
// sustained scanner floods cannot be amplified into full-map scans.
const EVICT_SCAN_BUDGET = 64;

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

// Explicit trust boundary for X-Forwarded-For (TOG-6029).
//
// Default (no trusted proxy configured): returns the direct TCP peer —
// XFF is ignored entirely, so spoofed headers cannot rotate identities.
//
// Opt-in (exactly one trusted proxy hop): when `trustedProxyIp` is set and
// the direct peer normalizes to it, the leftmost XFF entry is the client.
// Single-hop only: entries beyond the first are proxy-chain artifacts and
// are never consulted. Missing/empty/unparseable XFF falls back to the
// direct peer. A direct peer that is NOT the trusted proxy never consults
// XFF, whatever the header claims.
//
// Both inputs are normalized with normalizeClientIp, so `127.0.0.1` matches
// a `::ffff:127.0.0.1` peer or header entry.
export function resolveClientIp(remoteAddress, xForwardedFor, trustedProxyIp = null) {
  const peer = normalizeClientIp(remoteAddress);
  const trusted = trustedProxyIp === null || trustedProxyIp === undefined
    ? null
    : normalizeClientIp(trustedProxyIp);
  if (trusted === null || trusted === "unknown" || peer !== trusted) {
    return peer;
  }
  const first = String(xForwardedFor ?? "").split(",")[0].trim();
  if (first === "") {
    return peer;
  }
  // Fail closed on unparseable input: the token must consist solely of
  // IP characters (digits, dots, hex, colons, `%zone`) and be an IPv4
  // dotted-quad or a colon-bearing (IPv6) value. Anything else — garbage,
  // hostnames, whitespace/control-character injection attempts — falls
  // back to the direct peer so it cannot mint arbitrary bucket keys.
  const looksLikeIp =
    /^[0-9a-fA-F.:%]+$/.test(first) &&
    (/^\d{1,3}(\.\d{1,3}){3}$/.test(first) || first.includes(":"));
  if (!looksLikeIp) {
    return peer;
  }
  const client = normalizeClientIp(first);
  return client === "unknown" ? peer : client;
}

export function createRateLimiter({ windowMs, max, maxBuckets } = {}) {
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_RATE_LIMIT.windowMs;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_RATE_LIMIT.max;
  const cap =
    Number.isFinite(maxBuckets) && maxBuckets > 0 ? Math.floor(maxBuckets) : MAX_BUCKETS;
  // key `${ip} ${bucket}` -> { count, resetAt }. Insertion order is LRU
  // order: every live hit re-inserts its entry (delete + set), so the
  // first key is always the least-recently-used candidate.
  const counts = new Map();

  // TTL sweep on insert past the cap: drop up to EVICT_SCAN_BUDGET
  // expired windows and report whether anything was freed. Scanning only
  // a bounded prefix keeps per-insert eviction work O(1); entries beyond
  // the budget are left for later sweeps (or overwritten on hit), and the
  // LRU fallback below keeps memory bounded regardless.
  function evictExpired(now) {
    const before = counts.size;
    let scanned = 0;
    for (const [key, entry] of counts) {
      if (scanned >= EVICT_SCAN_BUDGET) {
        break;
      }
      scanned += 1;
      if (now >= entry.resetAt) {
        counts.delete(key);
      }
    }
    return counts.size < before;
  }

  return {
    windowMs: window,
    max: limit,
    maxBuckets: cap,
    // Introspection for tests/ops: live (unexpired) bucket count at `now`.
    liveBucketCount(now = Date.now()) {
      let live = 0;
      for (const entry of counts.values()) {
        if (now < entry.resetAt) {
          live += 1;
        }
      }
      return live;
    },
    check(ip, bucket, now = Date.now()) {
      const key = `${normalizeClientIp(ip)} ${bucket}`;
      let entry = counts.get(key);
      if (entry && now < entry.resetAt) {
        // Live hit: refresh LRU recency, then apply the budget.
        counts.delete(key);
        counts.set(key, entry);
      } else {
        // New or expired window: (re)create the bucket.
        if (entry) {
          counts.delete(key);
        }
        entry = { count: 0, resetAt: now + window };
        if (counts.size >= cap) {
          if (!evictExpired(now) && counts.size >= cap) {
            // No expired bucket freed by the bounded sweep: drop the LRU
            // key (insertion-order head). `counts` is non-empty here, so
            // oldestKey is always defined.
            const oldestKey = counts.keys().next().value;
            counts.delete(oldestKey);
          }
        }
        counts.set(key, entry);
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
