// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882)
// with the shell-first loading state (TOG-5499).
//
// Zero dependencies: Node built-in http only. Routes:
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

import { createServer } from "node:http";
import { isPreviewEnabled } from "./preview.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  listingDetailFragment,
  renderInvalidFilter,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
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

export function createApp(env = process.env, options = {}) {
  const limiter = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  return createServer((req, res) => {
    // Per-IP/per-route cap (TOG-5563). Bucket by route shape so one hot
    // listing cannot starve — or be starved by — unrelated routes.
    // Unparseable targets count against the fallback bucket so garbage
    // requests cannot bypass the cap.
    const ip = req.socket?.remoteAddress ?? "unknown";
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

    sendJson(res, 404, { error: "not_found" });
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

export function resolvePort(raw = process.env.PORT ?? "3000") {
  const port = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Invalid PORT ${JSON.stringify(String(raw))}: expected an integer 1-65535`);
  }
  return port;
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
  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `wayselect preview server on http://${host}:${port} (preview=${isPreviewEnabled() ? "on" : "off"})`,
    );
  });
}
