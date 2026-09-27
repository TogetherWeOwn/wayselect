// Tests for TOG-6028: /listings limit/offset pagination (node:test, zero
// dependencies).
//
// Pins the server contract (bounded HTML, exact windows, fail-closed 400s)
// and the pure-function contract (defaults, cap, slicing):
//   - default page: absent params -> limit 20, offset 0; render bounded
//   - offset paging: limit/offset slices the filtered array in stub order
//   - cap: limit > 100 fails closed with a 400 naming the valid range
//   - invalid input: non-integer / zero / negative values fail closed (400),
//     never silently coerced; offset past the end is a valid empty page

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  LISTINGS_DEFAULT_LIMIT,
  LISTINGS_MAX_LIMIT,
  applyListingsFilters,
  emptyFilters,
  paginateListings,
  parseListingsQuery,
} from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

// Synthetic catalog larger than any cap, in a fixed order.
function bigCatalog(n) {
  return Array.from({ length: n }, (_, i) => ({
    providerId: "synth",
    providerName: "Synthetic",
    modelId: `model-${String(i).padStart(3, "0")}`,
    entry: { name: `Model ${i}` },
  }));
}

function liCount(html) {
  return (html.match(/<li>/g) ?? []).length;
}

describe("parseListingsQuery paging (TOG-6028)", () => {
  it("defaults to limit 20, offset 0 when absent", () => {
    strictEqual(LISTINGS_DEFAULT_LIMIT, 20);
    strictEqual(LISTINGS_MAX_LIMIT, 100);
    const parsed = parseListingsQuery(params(""));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.paging.limit, 20);
    strictEqual(parsed.paging.offset, 0);
  });

  it("accepts explicit limit and offset", () => {
    const parsed = parseListingsQuery(params("?limit=5&offset=10"));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.paging.limit, 5);
    strictEqual(parsed.paging.offset, 10);
  });

  it("fails closed on limit over the max cap", () => {
    const parsed = parseListingsQuery(params("?limit=101"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "limit");
  });

  it("accepts the max cap exactly", () => {
    const parsed = parseListingsQuery(params("?limit=100"));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.paging.limit, 100);
  });

  it("fails closed on non-integer, zero, negative, or empty paging values", () => {
    for (const query of [
      "?limit=abc",
      "?limit=1.5",
      "?limit=0",
      "?limit=-3",
      "?limit=",
      "?limit=5x",
      "?offset=-1",
      "?offset=1.5",
      "?offset=abc",
      "?offset=",
    ]) {
      const parsed = parseListingsQuery(params(query));
      strictEqual(parsed.ok, false, `expected 400 for ${query}`);
    }
  });
});

describe("paginateListings (TOG-6028)", () => {
  it("returns the exact window in order and keeps the total", () => {
    const catalog = bigCatalog(30);
    const { page, total, limit, offset } = paginateListings(catalog, { limit: 5, offset: 10 });
    strictEqual(total, 30);
    strictEqual(limit, 5);
    strictEqual(offset, 10);
    strictEqual(page.length, 5);
    strictEqual(page[0].modelId, "model-010");
    strictEqual(page[4].modelId, "model-014");
  });

  it("bounds the default page on a large catalog", () => {
    const { page, total } = paginateListings(bigCatalog(150), {
      limit: LISTINGS_DEFAULT_LIMIT,
      offset: 0,
    });
    strictEqual(total, 150);
    strictEqual(page.length, LISTINGS_DEFAULT_LIMIT);
  });

  it("returns an empty page (not an error) for offset past the end", () => {
    const { page, total } = paginateListings(bigCatalog(10), { limit: 5, offset: 10 });
    strictEqual(total, 10);
    strictEqual(page.length, 0);
  });

  it("clips the last partial window without padding", () => {
    const { page } = paginateListings(bigCatalog(10), { limit: 5, offset: 8 });
    strictEqual(page.length, 2);
    strictEqual(page[0].modelId, "model-008");
  });
});

describe("paged index rendering (TOG-6028)", () => {
  it("keeps the legacy count copy when the whole array renders", () => {
    const html = renderListingIndex([...STUB_LISTINGS], undefined, emptyFilters(), {
      total: STUB_LISTINGS.length,
      limit: 20,
      offset: 0,
    });
    ok(html.includes(`${STUB_LISTINGS.length} listings found.`), "legacy copy kept");
    ok(!html.includes("Showing"), "no window suffix for the full array");
  });

  it("announces the window and links Next while preserving filters", () => {
    const catalog = bigCatalog(30);
    const { page, total, limit, offset } = paginateListings(catalog, { limit: 5, offset: 0 });
    const html = renderListingIndex(page, undefined, { ...emptyFilters(), q: "synth" }, {
      total,
      limit,
      offset,
    });
    ok(html.includes("30 listings found. Showing 1-5."), "window announced");
    strictEqual(liCount(html), 5);
    ok(html.includes("Next"), "next link");
    ok(!html.includes("Previous"), "no previous on first page");
    ok(html.includes("q=synth"), "filter preserved in page link");
  });

  it("links Previous on later pages and names the empty page distinctly", () => {
    const catalog = bigCatalog(10);
    const mid = paginateListings(catalog, { limit: 5, offset: 5 });
    const midHtml = renderListingIndex(mid.page, undefined, emptyFilters(), mid);
    ok(midHtml.includes("Showing 6-10."), "second window announced");
    ok(midHtml.includes("Previous"), "previous link");

    const pastEnd = paginateListings(catalog, { limit: 5, offset: 10 });
    const endHtml = renderListingIndex(pastEnd.page, undefined, emptyFilters(), pastEnd);
    ok(endHtml.includes("No listings on this page."), "empty-page copy");
    ok(!endHtml.includes("No listings match these filters."), "not blamed on filters");
    ok(endHtml.includes("Back to first page"), "recovery link");
  });
});

describe("paged index server routes (TOG-6028)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("bounds GET /listings by the default cap", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("3 listings found."), "full stub catalog under the cap");
    strictEqual(liCount(html), 3);
  });

  it("returns exactly the requested window for limit/offset", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Second stub only: limit=1&offset=1 -> Image Lite.
    const res = await fetch(`${base}/listings?limit=1&offset=1`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 1);
    ok(html.includes("Image Lite"), "window holds the second stub");
    ok(!html.includes("Alpha Chat"), "window excludes the first stub");
    ok(html.includes("3 listings found. Showing 2-2."), "window announced");
  });

  it("returns the (empty) window for offset past the end", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?limit=5&offset=10`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 0);
    ok(html.includes("No listings on this page."), "empty-window copy");
  });

  it("returns 400 for over-cap and malformed paging values", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const query of ["?limit=101", "?limit=abc", "?limit=0", "?offset=-1", "?offset=1.5"]) {
      const res = await fetch(`${base}/listings${query}`);
      strictEqual(res.status, 400, `expected 400 for ${query}`);
      ok((await res.text()).includes("<h1>Invalid filter</h1>"), "invalid-filter page");
    }
  });

  it("pages the filtered result, not the raw catalog", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // q=alpha matches 1 of 3: the full filtered window keeps legacy copy.
    const single = await fetch(`${base}/listings?q=alpha&limit=1&offset=0`);
    strictEqual(single.status, 200);
    const singleHtml = await single.text();
    strictEqual(liCount(singleHtml), 1);
    ok(singleHtml.includes("1 listing found."), "singular filtered total");
    ok(singleHtml.includes("Alpha Chat"), "filtered window holds the match");
    // modality=text matches all 3: paging slices the filtered set.
    const res = await fetch(`${base}/listings?modality=text&limit=1&offset=1`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 1);
    ok(html.includes("3 listings found. Showing 2-2."), "filtered window announced");
    ok(html.includes("Image Lite"), "second filtered item");
  });
});

describe("sorted index server routes (TOG-6362)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  // Stub order is alpha-chat, image-lite, unknown-tools; price-asc is
  // unknown-tools (0.75), image-lite (2), alpha-chat (3).
  function positions(html) {
    return {
      alpha: html.indexOf("Alpha Chat"),
      image: html.indexOf("Image Lite"),
      unknown: html.indexOf("Unknown Tools"),
    };
  }

  it("keeps stub order by default (no behavior change)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const query of ["", "?sort=default"]) {
      const res = await fetch(`${base}/listings${query}`);
      strictEqual(res.status, 200, `expected 200 for ${query || "(no params)"}`);
      const { alpha, image, unknown } = positions(await res.text());
      ok(alpha !== -1 && image !== -1 && unknown !== -1, "all stubs listed");
      ok(alpha < image && image < unknown, `stub order kept for ${query || "(no params)"}`);
    }
  });

  it("orders the index by price-asc over HTTP", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?sort=price-asc`);
    strictEqual(res.status, 200);
    const { alpha, image, unknown } = positions(await res.text());
    ok(unknown < image && image < alpha, "cheapest stub first");
  });

  it("orders the index by name-asc and route-asc over HTTP", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const sort of ["name-asc", "route-asc"]) {
      const res = await fetch(`${base}/listings?sort=${sort}`);
      strictEqual(res.status, 200, `expected 200 for sort=${sort}`);
      const { alpha, image, unknown } = positions(await res.text());
      ok(alpha < image && image < unknown, `alphabetical order for sort=${sort}`);
    }
  });

  it("sorts before paging: the window holds the cheapest stubs", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?sort=price-asc&limit=1&offset=0`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 1);
    ok(html.includes("Unknown Tools"), "first sorted window item is cheapest");
    ok(html.includes("3 listings found. Showing 1-1."), "sorted total + window announced");
  });

  it("sorts the filtered set, not the raw catalog", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // modality=text matches all 3: price-desc puts alpha-chat first.
    const res = await fetch(`${base}/listings?modality=text&sort=price-desc&limit=1&offset=0`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 1);
    ok(html.includes("Alpha Chat"), "most expensive first");
  });

  it("preserves the sort in Next/Previous page links", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?sort=price-asc&limit=1&offset=0`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("sort=price-asc"), "page links carry the sort");
    ok(!html.includes("sort=default"), "default sort stays unpinned in links");
  });

  it("returns 400 naming the valid sorts for unknown sort values", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?sort=cheapest`);
    strictEqual(res.status, 400);
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "invalid-filter page");
    ok(html.includes("price-asc"), "valid sorts named");
  });
});
