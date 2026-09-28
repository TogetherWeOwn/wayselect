// Tests for TOG-7275: /listings pagination nav semantics (node:test, zero
// dependencies).
//
// Pins the accessible pagination contract on the served index:
//   - the Previous/Next adjacent links carry rel="prev"/rel="next"
//   - the current page number link carries aria-current="page"
//   - edge pages omit the absent direction (no Previous on first, no Next
//     on last) while still marking the current page

import { ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { emptyFilters, paginateListings } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

// Synthetic catalog in a fixed order.
function bigCatalog(n) {
  return Array.from({ length: n }, (_, i) => ({
    providerId: "synth",
    providerName: "Synthetic",
    modelId: `model-${String(i).padStart(3, "0")}`,
    entry: { name: `Model ${i}` },
  }));
}

function renderPage(catalog, limit, offset) {
  const window = paginateListings(catalog, { limit, offset });
  return renderListingIndex(window.page, undefined, emptyFilters(), window);
}

describe("pagination nav semantics (TOG-7275)", () => {
  it("marks adjacent links with rel=prev/next and the current page with aria-current", () => {
    // Page 3 of 6: both directions present.
    const html = renderPage(bigCatalog(30), 5, 10);
    ok(html.includes('rel="prev"'), "previous link carries rel=prev");
    ok(html.includes('rel="next"'), "next link carries rel=next");
    ok(html.includes('aria-current="page">3<'), "current page marked");
  });

  it("omits Previous on the first page but keeps rel=next and aria-current", () => {
    const html = renderPage(bigCatalog(30), 5, 0);
    ok(!html.includes('rel="prev"'), "no previous on first page");
    ok(html.includes('rel="next"'), "next link carries rel=next");
    ok(html.includes('aria-current="page">1<'), "page 1 marked current");
  });

  it("omits Next on the last page but keeps rel=prev and aria-current", () => {
    const html = renderPage(bigCatalog(30), 5, 25);
    ok(html.includes('rel="prev"'), "previous link carries rel=prev");
    ok(!html.includes('rel="next"'), "no next on last page");
    ok(html.includes('aria-current="page">6<'), "page 6 marked current");
  });

  it("renders no page nav when the whole catalog fits on one page", () => {
    const html = renderPage(bigCatalog(3), 20, 0);
    ok(!html.includes('aria-label="Listings pages"'), "no pagination nav");
    ok(!html.includes('rel="prev"') && !html.includes('rel="next"'), "no adjacent links");
  });
});

describe("pagination nav semantics on served pages (TOG-7275)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves rel=prev/next and aria-current on a middle /listings page", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Second stub of 3: limit=1&offset=1 -> page 2 of 3.
    const res = await fetch(`${base}/listings?limit=1&offset=1`);
    ok(res.status === 200, "middle page serves 200");
    const html = await res.text();
    ok(html.includes('rel="prev"'), "served previous carries rel=prev");
    ok(html.includes('rel="next"'), "served next carries rel=next");
    ok(html.includes('aria-current="page">2<'), "served page 2 marked current");
  });
});
