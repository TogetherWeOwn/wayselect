// Tests for TOG-7314: /listings pagination links preserve the active
// q/filters (node:test, zero dependencies).
//
// Audit result: `pageHref` (web/listing-detail.js) already keeps q,
// capability, modality (and limit) on every pagination link shape —
// Prev/Next, numbered pages where present, and the past-end "Back to first
// page" recovery link. No source change; this file is the regression pin so
// a future pageHref change that drops a filter fails loudly. Assertions
// stay portable across nav variants (numbered links and rel attributes are
// pinned separately by TOG-7275, not here).
//
// Pins:
//   - every pagination link on a filtered middle page keeps q + each
//     capability + each modality + limit
//   - the past-end recovery link keeps q
//   - served round-trip: fetching page 1 with q, following its Next href,
//     lands on a still-filtered page 2 whose own links still carry q

import { ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { paginateListings } from "../web/filter.js";
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

const FILTERS = Object.freeze({
  q: "synth chat",
  capabilities: ["tool_call"],
  modalities: ["text"],
});

// Pagination hrefs for every nav link shape (Prev/Next plus numbered page
// links where the renderer emits them). Result-item links are excluded.
// HTML-escaped, so decode &amp; before asserting.
function pageHrefs(html) {
  return [...html.matchAll(/<a href="([^"]+)"[^>]*>(?:Previous|Next|\d+)<\/a>/g)].map((m) =>
    m[1].replaceAll("&amp;", "&"),
  );
}

function assertFiltersKept(href) {
  const params = new URL(href, "http://localhost").searchParams;
  ok(params.get("q") === FILTERS.q, `q survives in ${href}`);
  ok(params.getAll("capability").join() === "tool_call", `capability survives in ${href}`);
  ok(params.getAll("modality").join() === "text", `modality survives in ${href}`);
  ok(params.get("limit") === "5", `limit survives in ${href}`);
}

describe("pagination preserves active filters (TOG-7314)", () => {
  it("keeps q, capability, modality and limit on every page link", () => {
    // Middle page: Prev + Next present (plus numbered links where emitted).
    const catalog = bigCatalog(30);
    const window = paginateListings(catalog, { limit: 5, offset: 10 });
    const html = renderListingIndex(window.page, undefined, { ...FILTERS }, {
      ...window,
      total: 30,
    });
    const hrefs = pageHrefs(html);
    ok(hrefs.length >= 2, `expected Prev + Next links at least, got ${hrefs.length}`);
    for (const href of hrefs) {
      assertFiltersKept(href);
    }
  });

  it("keeps q on the past-end Back to first page recovery link", () => {
    const catalog = bigCatalog(10);
    const window = paginateListings(catalog, { limit: 5, offset: 10 });
    const html = renderListingIndex(window.page, undefined, { ...FILTERS }, {
      ...window,
      total: 10,
    });
    ok(html.includes("Back to first page"), "recovery link present");
    const match = html.match(/<a href="([^"]+)">Back to first page<\/a>/);
    ok(match, "recovery href found");
    const params = new URL(match[1].replaceAll("&amp;", "&"), "http://localhost").searchParams;
    ok(params.get("q") === FILTERS.q, "q survives on the recovery link");
  });
});

describe("q survives served page navigation (TOG-7314)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("following the served Next href keeps the filter applied", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // q=northstar matches all 3 stubs via providerName; limit=1 forces paging.
    const first = await fetch(`${base}/listings?q=northstar&limit=1&offset=0`);
    ok(first.status === 200, "page 1 serves 200");
    const firstHtml = await first.text();
    ok(firstHtml.includes("3 listings found. Showing 1-1."), "page 1 filtered window");
    const nextMatch = firstHtml.match(/<a href="([^"]+)"[^>]*>Next<\/a>/);
    ok(nextMatch, "page 1 carries a Next link");
    const nextUrl = nextMatch[1].replaceAll("&amp;", "&");
    ok(nextUrl.includes("q=northstar"), "Next href keeps q");
    const second = await fetch(`${base}${nextUrl}`);
    ok(second.status === 200, "followed page 2 serves 200");
    const secondHtml = await second.text();
    ok(secondHtml.includes("3 listings found. Showing 2-2."), "page 2 still filtered");
    ok(secondHtml.includes("q=northstar"), "page 2 links still carry q");
  });
});
