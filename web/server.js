// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /listings                          — stub listing index (flag-gated)
//   GET /listings/:provider/:model         — listing-detail page (flag-gated)
//   POST /listings/:provider/:model/purchase — stub CTA target, always 403 (no backend writes)
// Everything else 404. When WAYSELECT_PREVIEW is off, gated routes return 404.

import { createServer } from "node:http";
import { isPreviewEnabled } from "./preview.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  renderInvalidFilter,
  renderListingDetail,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
} from "./listing-detail.js";
import { applyListingsFilters, parseListingsQuery } from "./filter.js";
import { STUB_LISTINGS, getStubListing } from "./stub-listing.js";

const LISTING_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/?$/;
const PURCHASE_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/purchase\/?$/;

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
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
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
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
      sendHtml(
        res,
        200,
        renderListingIndex(applyListingsFilters(STUB_LISTINGS, parsed.filters), undefined, parsed.filters),
      );
      return;
    }

    const purchaseMatch = pathname.match(PURCHASE_ROUTE);
    if (purchaseMatch) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method_not_allowed" });
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
    if (listingMatch && req.method === "GET") {
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
        sendHtml(res, 404, renderNotFound(providerId, modelId));
        return;
      }
      sendHtml(res, 200, renderListingDetail(listing));
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = createApp();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `wayselect preview server on http://localhost:${port} (preview=${isPreviewEnabled() ? "on" : "off"})`,
    );
  });
}
