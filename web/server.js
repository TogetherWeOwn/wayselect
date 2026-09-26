// Minimal preview web server for the search/filter slice (TOG-4916).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /listings[?q=&category=&status=] — stub search/filter page (flag-gated)
// Everything else 404. When WAYSELECT_PREVIEW is off, the gated route
// returns 404. Search/filter runs against typed fixtures in-process; no
// backend wiring or writes.

import { createServer } from "node:http";
import { isPreviewEnabled } from "./preview.js";
import { STUB_LISTINGS } from "./stub-listing.js";
import { filterListings, normalizeFilters } from "./search-filter.js";
import { renderPreviewDisabled, renderSearchPage } from "./search-page.js";

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function filtersFromQuery(params) {
  return normalizeFilters({
    query: params.get("q") ?? "",
    category: params.get("category") ?? "all",
    status: params.get("status") ?? "all",
  });
}

export function createApp(env = process.env) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname, searchParams } = url;

    if (req.method === "GET" && (pathname === "/listings" || pathname === "/listings/")) {
      if (!isPreviewEnabled(env)) {
        sendHtml(res, 404, renderPreviewDisabled());
        return;
      }
      const filters = filtersFromQuery(searchParams);
      const results = filterListings(STUB_LISTINGS, filters);
      sendHtml(res, 200, renderSearchPage({ listings: results, total: STUB_LISTINGS, filters }));
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
