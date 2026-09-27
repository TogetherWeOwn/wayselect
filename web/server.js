// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882)
// with the shell-first loading state (TOG-5499).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /healthz                            — liveness probe (TOG-5726):
//                                            `{status:"ok",version}` JSON,
//                                            ungated by WAYSELECT_PREVIEW
//                                            and exempt from rate limiting
//   GET /listings                          — stub listing index (flag-gated)
//   GET /listings/:provider/:model         — listing-detail shell (flag-gated;
//                                            `Accept: application/json` returns
//                                            the `{ html }` content fragment)
//   POST /listings/:provider/:model/purchase — stub CTA target: 404 for
//                                            unknown listings, 403 for known
//                                            listings (no backend writes)
// Everything else 404. When WAYSELECT_PREVIEW is off, gated routes return 404.
//
// Security headers (TOG-5731):
//   - Every response carries `X-Content-Type-Options: nosniff` (HTML and
//     JSON alike, including the 429 rate-limit refusal below).
//   - HTML responses additionally deny framing (`X-Frame-Options: DENY`
//     plus `frame-ancestors 'none'`) and carry a minimal CSP. The pages
//     use an inline `<style>` block and (on the detail shell) an inline
//     `<script>` that same-origin fetches the JSON fragment, so the
//     policy allows `'unsafe-inline'` for style/script while keeping
//     everything else same-origin: no external resources exist.
//
// 404 content-type contract (TOG-5714):
//   - Browser routes (index, detail incl. listing misses, flag-off pages):
//     HTML by default; JSON only when the client explicitly negotiates
//     `Accept: application/json` (the shell's fragment fetch).
//   - API-shaped routes (purchase stub incl. 405s) and unparseable targets:
//     always JSON.
//   - Unknown paths (fallback below): JSON `{error: "not_found"}` by
//     default; HTML only when the client explicitly negotiates
//     `Accept: text/html` without `application/json` (a browser address-bar
//     navigation). `*/*` (fetch/curl defaults) gets JSON.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isPreviewEnabled } from "./preview.js";
import { createRateLimiter, resolveClientIp } from "./rate-limit.js";
import {
  listingDetailFragment,
  renderInvalidFilter,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
  renderRouteNotFound,
} from "./listing-detail.js";
import { applyListingsFilters, paginateListings, parseListingsQuery } from "./filter.js";
import { STUB_LISTINGS, getStubListing } from "./stub-listing.js";

const LISTING_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/?$/;
const PURCHASE_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/purchase\/?$/;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// HTML-only hardening (TOG-5731): deny framing both the legacy
// (`X-Frame-Options`) and the standard (`frame-ancestors`) way, and lock
// the page to same-origin resources with a minimal CSP. `style-src` and
// `script-src` keep `'unsafe-inline'` because every page carries an inline
// `<style>` block and the detail shell carries an inline `<script>` that
// same-origin fetches its JSON fragment; `form-action 'self'` covers the
// filter GET form and the purchase POST form.
const HTML_SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; frame-ancestors 'none'; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
    "img-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'",
};

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
    ...HTML_SECURITY_HEADERS,
  });
  res.end(html);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(payload));
}

// Bucket requests by route shape for the rate limiter: exact path for the
// index, route templates for detail/purchase, and a fallback for 404s so
// scanners cannot burn the budget of real routes (or vice versa).
function routeBucket(method, pathname) {
  if (method === "GET" && (pathname === "/listings" || pathname === "/listings/")) {
    return "GET /listings";
  }
  if (PURCHASE_ROUTE.test(pathname)) {
    return `${method} /listings/:provider/:model/purchase`;
  }
  if (LISTING_ROUTE.test(pathname)) {
    return `${method} /listings/:provider/:model`;
  }
  return `${method} other`;
}

// Server version reported by GET /healthz (TOG-5726). Read once at module
// load from the package manifest; a missing/unparseable manifest degrades
// to "unknown" rather than breaking the server.
function loadServerVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const SERVER_VERSION = loadServerVersion();

export function createApp(env = process.env, options = {}) {
  const limiter = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  // XFF trust boundary (TOG-6029): unset by default (direct-remote only).
  // Opt-in for a single trusted proxy hop via `trustedProxyIp` option or
  // the `WAYSELECT_TRUSTED_PROXY_IP` env var — exactly one peer IP. Empty
  // string env counts as unset. Documented in rate-limit.js; no prod use.
  const rawTrusted = options.trustedProxyIp ?? env.WAYSELECT_TRUSTED_PROXY_IP ?? null;
  const trustedProxyIp = rawTrusted === null || String(rawTrusted).trim() === "" ? null : String(rawTrusted).trim();
  return createServer((req, res) => {
    // TOG-5726: /healthz is the orchestrator liveness probe. It answers
    // before rate limiting (a saturated limiter must not look like a dead
    // server) and regardless of WAYSELECT_PREVIEW (the flag gates content
    // routes, not process health). Pathname match: query strings still hit
    // the probe, but a trailing slash is a different path and falls through
    // to the 404 contract below.
    let probePathname = null;
    try {
      probePathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      probePathname = null;
    }
    if (req.method === "GET" && probePathname === "/healthz") {
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION });
      return;
    }
    if (probePathname === "/healthz") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // Per-IP/per-route cap (TOG-5563). Bucket by route shape so one hot
    // listing cannot starve — or be starved by — unrelated routes.
    // Unparseable targets count against the fallback bucket so garbage
    // requests cannot bypass the cap. Client identity goes through
    // resolveClientIp so spoofed XFF from an untrusted peer never evades
    // the bucket (TOG-6029).
    const ip = resolveClientIp(
      req.socket?.remoteAddress ?? "unknown",
      req.headers?.["x-forwarded-for"],
      trustedProxyIp,
    );
    let pathname = null;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = null;
    }
    const bucket = pathname === null ? `${req.method} other` : routeBucket(req.method, pathname);
    const verdict = limiter.check(ip, bucket);
    if (!verdict.allowed) {
      // TOG-5732 audit: the 429 path previously bypassed sendJson and so
      // missed SECURITY_HEADERS — every response carries them now.
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        ...SECURITY_HEADERS,
        "retry-after": String(verdict.retryAfterSec),
      });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSec: verdict.retryAfterSec }));
      return;
    }

    if (pathname === null) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method === "GET" && (pathname === "/listings" || pathname === "/listings/")) {
      if (!isPreviewEnabled(env)) {
        sendHtml(res, 404, renderPreviewDisabled());
        return;
      }
      let params;
      try {
        params = new URL(req.url ?? "/", "http://localhost").searchParams;
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const parsed = parseListingsQuery(params);
      if (!parsed.ok) {
        sendHtml(res, 400, renderInvalidFilter(parsed));
        return;
      }
      const filtered = applyListingsFilters(STUB_LISTINGS, parsed.filters);
      // TOG-6028: bound the HTML render with limit/offset (fail-closed above).
      const { page, total, limit, offset } = paginateListings(filtered, parsed.paging);
      sendHtml(
        res,
        200,
        renderListingIndex(page, undefined, parsed.filters, { total, limit, offset }),
      );
      return;
    }

    const purchaseMatch = pathname.match(PURCHASE_ROUTE);
    if (purchaseMatch) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      // TOG-5710: a nonexistent resource must 404 first; 403 is only
      // correct for a real listing (writes disabled by design).
      const [, rawProviderId, rawModelId] = purchaseMatch;
      let providerId;
      let modelId;
      try {
        providerId = decodeURIComponent(rawProviderId);
        modelId = decodeURIComponent(rawModelId);
      } catch {
        sendJson(res, 404, { error: "listing_not_found" });
        return;
      }
      if (!getStubListing(providerId, modelId)) {
        sendJson(res, 404, { error: "listing_not_found" });
        return;
      }
      // Stub CTA target: never writes, always refuses.
      sendJson(res, 403, {
        error: "preview_only",
        message: "Purchases are disabled in preview. No backend writes.",
      });
      return;
    }

    const listingMatch = pathname.match(LISTING_ROUTE);
    if (listingMatch) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (!isPreviewEnabled(env)) {
        sendHtml(res, 404, renderPreviewDisabled());
        return;
      }
      const [, providerId, modelId] = listingMatch;
      let decodedProviderId;
      let decodedModelId;
      try {
        decodedProviderId = decodeURIComponent(providerId);
        decodedModelId = decodeURIComponent(modelId);
      } catch {
        sendHtml(res, 404, renderNotFound(providerId, modelId));
        return;
      }
      const listing = getStubListing(decodedProviderId, decodedModelId);
      if (!listing) {
        // TOG-5499: fragment callers (the shell's inline fetch) negotiate
        // JSON, so misses degrade to an error payload the shell renders as
        // the alert panel — never a JSON parse crash on an HTML page.
        if (String(req.headers?.accept ?? "").includes("application/json")) {
          sendJson(res, 404, { error: "listing_not_found" });
          return;
        }
        sendHtml(res, 404, renderNotFound(providerId, modelId));
        return;
      }
      // TOG-5499: the shell's inline fetch negotiates this fragment.
      // Test/dev slow-network knob: delays the fragment only, never the
      // shell first paint. Unset or non-positive means no delay.
      if (String(req.headers?.accept ?? "").includes("application/json")) {
        const sendFragment = () => {
          try {
            sendJson(res, 200, listingDetailFragment(listing));
          } catch {
            sendHtml(res, 500, renderListingDetailError(decodedProviderId, decodedModelId));
          }
        };
        const fragmentDelayMs = Number.parseInt(
          String(env.WAYSELECT_DETAIL_FRAGMENT_DELAY_MS ?? "0"),
          10,
        );
        if (Number.isFinite(fragmentDelayMs) && fragmentDelayMs > 0) {
          setTimeout(sendFragment, fragmentDelayMs);
        } else {
          sendFragment();
        }
        return;
      }
      try {
        sendHtml(res, 200, renderListingDetailShell(listing));
      } catch {
        sendHtml(res, 500, renderListingDetailError(decodedProviderId, decodedModelId));
      }
      return;
    }

    // TOG-5714 fallback (see the 404 content-type contract above):
    // unknown paths are JSON by default; HTML only for explicit browser
    // navigation (`Accept: text/html` without `application/json`). `*/*`
    // (fetch/curl defaults) and missing Accept get JSON.
    const accept = String(req.headers?.accept ?? "");
    if (!accept.includes("application/json") && accept.includes("text/html")) {
      sendHtml(res, 404, renderRouteNotFound(pathname));
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

export function resolvePort(raw = process.env.PORT ?? "3000") {
  // Strict decimal: parseInt would silently accept "3.5" as 3 or "3000x"
  // as 3000, starting the server on a port the operator did not ask for.
  const text = String(raw).trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Invalid PORT ${JSON.stringify(String(raw))}: expected an integer 1-65535`);
  }
  return port;
}

// Graceful shutdown (TOG-5726): on SIGTERM/SIGINT stop accepting new
// connections, then exit once in-flight requests drain (or after a bounded
// grace period so a stuck keep-alive cannot hold the deploy forever).
// Exported for tests; the main block below wires it to process signals.
export const SHUTDOWN_GRACE_MS = 5000;

export function installShutdownHandlers(server, options = {}) {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = options.exit ?? ((code) => process.exit(code));
  const timers = options.timers ?? { setTimeout, clearTimeout };
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, closing preview server`);
    const force = timers.setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error("graceful shutdown timed out, forcing exit");
      exit(1);
    }, graceMs);
    // A pending force-exit timer must not hold the event loop open on its
    // own once the server has drained and closed cleanly.
    force?.unref?.();
    server.close(() => {
      timers.clearTimeout(force);
      exit(0);
    });
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
}

if (isMainModule) {
  let port;
  try {
    port = resolvePort();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  }
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createApp();
  installShutdownHandlers(server);
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `wayselect preview server on http://${host}:${port} (preview=${isPreviewEnabled() ? "on" : "off"})`,
    );
  });
}
