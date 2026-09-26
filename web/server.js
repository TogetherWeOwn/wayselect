// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /listings                          — stub listing index (flag-gated)
//   GET /listings/:provider/:model         — listing-detail page (flag-gated)
//   POST /listings/:provider/:model/purchase — stub CTA target, always 403 (no backend writes)
// Everything else 404. When WAYSELECT_PREVIEW is off, gated routes return 404.

import { createServer } from "node:http";
import { isPreviewEnabled } from "./preview.js";
import {
  renderListingDetail,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
} from "./listing-detail.js";
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
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/listings" || pathname === "/listings/")) {
      if (!isPreviewEnabled(env)) {
        sendHtml(res, 404, renderPreviewDisabled());
        return;
      }
      sendHtml(res, 200, renderListingIndex(STUB_LISTINGS));
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
