// Tests for the TOG-4916 search/filter slice: preview flag, stub fixtures,
// filter logic, page renderer, and server routes (node:test, zero deps).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isPreviewEnabled } from "../web/preview.js";
import { STUB_LISTINGS, getStubListing } from "../web/stub-listing.js";
import {
  availableCategories,
  countByStatus,
  filterListings,
  listingCategory,
  listingStatus,
  normalizeFilters,
} from "../web/search-filter.js";
import { renderPreviewDisabled, renderSearchPage } from "../web/search-page.js";
import { createApp } from "../web/server.js";

describe("preview flag", () => {
  it("is off by default and on for truthy values", () => {
    strictEqual(isPreviewEnabled({}), false);
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: "0" }), false);
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: "false" }), false);
    for (const value of ["1", "true", "TRUE", " on "]) {
      strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: value }), true, value);
    }
  });
});

describe("stub listings", () => {
  it("exposes frozen fixtures spanning categories and statuses", () => {
    ok(STUB_LISTINGS.length >= 4);
    ok(Object.isFrozen(STUB_LISTINGS));
    for (const listing of STUB_LISTINGS) {
      strictEqual(listing.schemaVersion, "v1");
      ok(listing.providerId.length > 0);
      ok(listing.modelId.length > 0);
      ok(listing.entry.name.length > 0);
      ok(Object.isFrozen(listing));
      ok(Object.isFrozen(listing.entry));
    }
    const statuses = new Set(STUB_LISTINGS.map(listingStatus));
    ok(statuses.has("stable"), "needs a stable listing");
    ok(statuses.has("beta"), "needs a beta listing");
    ok(statuses.has("deprecated"), "needs a deprecated listing");
    const categories = new Set(STUB_LISTINGS.map(listingCategory));
    ok(categories.size >= 2, "needs at least two categories");
  });

  it("looks up listings by provider/model and returns null for misses", () => {
    const found = getStubListing("northstar", "alpha-chat");
    ok(found);
    strictEqual(found.entry.name, "Alpha Chat");
    strictEqual(getStubListing("northstar", "nope"), null);
  });
});

describe("filter logic", () => {
  it("returns everything with default filters", () => {
    deepStrictEqual(
      filterListings(STUB_LISTINGS, {}).map((l) => l.modelId),
      STUB_LISTINGS.map((l) => l.modelId),
    );
  });

  it("matches query text case-insensitively across name, ids, description", () => {
    ok(filterListings(STUB_LISTINGS, { query: "alpha" }).some((l) => l.modelId === "alpha-chat"));
    ok(
      filterListings(STUB_LISTINGS, { query: "ALPHA" }).some((l) => l.modelId === "alpha-chat"),
    );
    ok(
      filterListings(STUB_LISTINGS, { query: "transcription" }).some(
        (l) => l.modelId === "audio-scribe",
      ),
    );
    ok(
      filterListings(STUB_LISTINGS, { query: "orbit retired" }).every(
        (l) => l.modelId === "retired-chat",
      ),
    );
    strictEqual(filterListings(STUB_LISTINGS, { query: "no-such-model-xyz" }).length, 0);
  });

  it("filters by category (primary input modality)", () => {
    const image = filterListings(STUB_LISTINGS, { category: "image" });
    ok(image.length >= 1);
    ok(image.every((l) => listingCategory(l) === "image"));
    const audio = filterListings(STUB_LISTINGS, { category: "audio" });
    ok(audio.length >= 1);
    ok(audio.every((l) => listingCategory(l) === "audio"));
  });

  it("filters by status, treating absent status as stable", () => {
    strictEqual(listingStatus(getStubListing("northstar", "alpha-chat")), "stable");
    const stable = filterListings(STUB_LISTINGS, { status: "stable" });
    ok(stable.length >= 1);
    ok(stable.every((l) => listingStatus(l) === "stable"));
    const beta = filterListings(STUB_LISTINGS, { status: "beta" });
    ok(beta.every((l) => listingStatus(l) === "beta"));
    const deprecated = filterListings(STUB_LISTINGS, { status: "deprecated" });
    ok(deprecated.every((l) => listingStatus(l) === "deprecated"));
  });

  it("combines query + category + status", () => {
    const combo = filterListings(STUB_LISTINGS, {
      query: "chat",
      category: "text",
      status: "stable",
    });
    ok(combo.length >= 1);
    ok(combo.every((l) => listingCategory(l) === "text" && listingStatus(l) === "stable"));
    strictEqual(
      filterListings(STUB_LISTINGS, { query: "chat", category: "image", status: "beta" }).length,
      0,
    );
    // A combo that isolates exactly one fixture proves filters intersect.
    deepStrictEqual(
      filterListings(STUB_LISTINGS, {
        query: "scribe",
        category: "audio",
        status: "stable",
      }).map((l) => l.modelId),
      ["audio-scribe"],
    );
  });

  it("normalizes unknown category/status to all instead of dropping rows", () => {
    deepStrictEqual(normalizeFilters({ category: "bogus", status: "bogus" }), {
      query: "",
      category: "all",
      status: "all",
    });
    strictEqual(filterListings(STUB_LISTINGS, { category: "bogus" }).length, STUB_LISTINGS.length);
    strictEqual(filterListings(STUB_LISTINGS, { status: "bogus" }).length, STUB_LISTINGS.length);
  });

  it("reports available categories and counts by status", () => {
    const categories = availableCategories(STUB_LISTINGS);
    ok(categories.includes("text"));
    const counts = countByStatus(STUB_LISTINGS);
    strictEqual(counts.stable + counts.beta + counts.deprecated, STUB_LISTINGS.length);
    ok(counts.beta >= 1 && counts.deprecated >= 1);
  });
});

describe("search page renderer", () => {
  it("renders the form, results, and result count", () => {
    const html = renderSearchPage({
      listings: STUB_LISTINGS,
      total: STUB_LISTINGS,
      filters: { query: "", category: "all", status: "all" },
    });
    ok(html.includes('role="search"'));
    ok(html.includes('name="q"'));
    ok(html.includes('name="category"'));
    ok(html.includes('name="status"'));
    ok(html.includes("Alpha Chat"));
    ok(html.includes(`Showing ${STUB_LISTINGS.length} of ${STUB_LISTINGS.length}`));
  });

  it("renders the empty-result state with a clear-filters path", () => {
    const html = renderSearchPage({
      listings: [],
      total: STUB_LISTINGS,
      filters: { query: "zzz-no-match", category: "image", status: "beta" },
    });
    ok(html.includes("No listings match these filters."));
    ok(html.includes("Clear all filters"));
    ok(!html.includes("<ul class=\"results\">"));
  });

  it("escapes untrusted values in query echo and result rows", () => {
    const evil = {
      ...getStubListing("northstar", "alpha-chat"),
      providerId: 'a"><script>alert(1)</script>',
      entry: {
        ...getStubListing("northstar", "alpha-chat").entry,
        name: "<b>evil</b>",
        description: "<img src=x onerror=alert(1)>",
      },
    };
    const html = renderSearchPage({
      listings: [evil],
      total: STUB_LISTINGS,
      filters: { query: "<script>alert(2)</script>", category: "all", status: "all" },
    });
    ok(!html.includes("<script>alert(1)</script>"));
    ok(!html.includes("<script>alert(2)</script>"));
    ok(html.includes("&lt;b&gt;evil&lt;/b&gt;"));
    ok(renderPreviewDisabled().includes("WAYSELECT_PREVIEW"));
  });
});

describe("preview server routes", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    return `http://localhost:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the search page on preview with stub data", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    ok((await res.text()).includes("Search listings"));
  });

  it("applies query + category + status from the URL", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=scribe&category=audio&status=stable`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("Audio Scribe"));
    ok(!html.includes("Alpha Chat"));
    const empty = await fetch(`${base}/listings?q=chat&category=image&status=beta`);
    strictEqual(empty.status, 200);
    ok((await empty.text()).includes("No listings match these filters."));
  });

  it("hides the gated route when the flag is off", async () => {
    const base = await start({});
    strictEqual((await fetch(`${base}/listings`)).status, 404);
    strictEqual((await fetch(`${base}/listings?q=chat`)).status, 404);
  });

  it("returns JSON 404 for unknown routes", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/nope`);
    strictEqual(res.status, 404);
    deepStrictEqual(await res.json(), { error: "not_found" });
  });
});
