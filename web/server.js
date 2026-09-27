// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882)
// with the shell-first loading state (TOG-5499).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /listings                          — stub listing index (flag-gated)
//   GET /listings/:provider/:model         — listing-detail shell (flag-gated;
//                                            `Accept: application/json` returns
//                                            the `{ html }` content fragment)
//   POST /listings/:provider/:model/purchase — stub CTA target, always 403 (no backend writes)
// Everything else 404. When WAYSELECT_PREVIEW is off, gated routes return 404.

import { createServer } from "node:http";
import { isPreviewEnabled } from "./preview.js";
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

export function createApp(env = process.env) {
  return createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
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
