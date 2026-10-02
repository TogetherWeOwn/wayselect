// TOG-6393: full-page index navigation targets the results section without
// changing headings, live-region announcements or keyboard tab order.
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyFilters } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { getStubListing } from "../web/stub-listing.js";
import { createApp } from "../web/server.js";

const NO_EVALUATIONS = new Map();
const alpha = getStubListing("northstar", "alpha-chat");

function anchors(html) {
  return [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(
    ([, href, label]) => ({ href: href.replaceAll("&amp;", "&"), label }),
  );
}

function assertTarget(html, state) {
  const section = html.match(/<section\b[^>]*id="results"[^>]*>[\s\S]*?<\/section>/)?.[0];
  ok(section, `${state}: results section rendered`);
  ok(section.includes('tabindex="-1"'), `${state}: target is outside the tab order`);
  ok(section.includes('aria-labelledby="results-heading"'), `${state}: accessible name retained`);
  ok(section.includes('<h2 id="results-heading">Results</h2>'), `${state}: visible heading retained`);
  strictEqual([...html.matchAll(/id="results"/g)].length, 1, `${state}: unique focus target`);
  strictEqual([...section.matchAll(/<p role="status" aria-live="polite">/g)].length, 1,
    `${state}: one unchanged polite live region`);
  const live = section.match(/<p role="status"[^>]*>/)[0];
  ok(!live.includes("tabindex") && !live.includes('id="'), `${state}: live region takes no focus`);
}

function page(rows, filters = emptyFilters(), pageInfo) {
  return renderListingIndex(rows, NO_EVALUATIONS, filters, pageInfo);
}

describe("listing focus management (TOG-6393)", () => {
  it("pins filter submits and clear links without changing native controls", () => {
    const html = page([alpha]);
    ok(html.includes('<form method="get" action="/listings#results"'), "bare action with fragment");
    ok(html.includes('aria-label="Filter listings"'), "form name retained");
    ok(html.includes('id="filter-q" name="q"'), "search identity retained");
    ok(html.includes('id="filter-sort" name="sort"'), "sort identity retained");
    ok(html.includes('<button type="submit">Apply filters</button>'), "native submit retained");
    const clear = anchors(html).filter((a) => a.label === "Clear filters");
    strictEqual(clear.length, 1);
    strictEqual(clear[0].href, "/listings#results");
  });

  it("provides the same focus target on populated, filter-miss and past-end pages", () => {
    assertTarget(page([alpha]), "populated");
    const miss = page([]);
    assertTarget(miss, "filter-miss");
    for (const a of anchors(miss).filter((a) => a.label === "Clear filters")) {
      strictEqual(a.href, "/listings#results");
    }
    assertTarget(page([], emptyFilters(), { total: 3, limit: 5, offset: 10 }), "past-end");
  });

  it("pins adjacent and numbered page links while preserving filters and pagination semantics", () => {
    const filters = { ...emptyFilters(), q: "synth#results", sort: "price-asc",
      capabilities: ["tool_call"], modalities: ["text"] };
    const html = page([alpha], filters, { total: 3, limit: 1, offset: 1 });
    const nav = html.match(/<nav aria-label="Listings pages">[\s\S]*?<\/nav>/)[0];
    const links = anchors(nav);
    strictEqual(links.length, 5, "previous, three numbered pages and next");
    for (const a of links) {
      const url = new URL(a.href, "https://example.invalid");
      strictEqual(url.hash, "#results", `${a.label}: focus fragment`);
      strictEqual(url.searchParams.get("q"), filters.q);
      strictEqual(url.searchParams.get("sort"), filters.sort);
      strictEqual(url.searchParams.get("capability"), "tool_call");
      strictEqual(url.searchParams.get("modality"), "text");
      strictEqual(url.searchParams.get("limit"), "1");
    }
    strictEqual(new URL(links.find((a) => a.label === "Previous").href,
      "https://example.invalid").searchParams.get("offset"), null);
    strictEqual(new URL(links.find((a) => a.label === "Next").href,
      "https://example.invalid").searchParams.get("offset"), "2");
    ok(nav.includes('rel="prev"') && nav.includes('rel="next"'), "adjacent rel values retained");
    strictEqual([...nav.matchAll(/aria-current="page"/g)].length, 1);
  });

  it("pins past-end recovery to the first page with active filters intact", () => {
    const html = page([], { ...emptyFilters(), q: "alpha", sort: "price-asc" },
      { total: 1, limit: 5, offset: 10 });
    const back = anchors(html).find((a) => a.label === "Back to first page");
    ok(back, "recovery link rendered");
    const url = new URL(back.href, "https://example.invalid");
    strictEqual(url.hash, "#results");
    strictEqual(url.searchParams.get("q"), "alpha");
    strictEqual(url.searchParams.get("sort"), "price-asc");
    strictEqual(url.searchParams.get("offset"), null);
  });

  it("serves the focus contract in all three states", async () => {
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const path of ["/listings?q=alpha", "/listings?q=zzz-no-such-listing",
        "/listings?limit=1&offset=99"]) {
        const res = await fetch(base + path);
        strictEqual(res.status, 200);
        const html = await res.text();
        assertTarget(html, path);
        ok(html.includes('<form method="get" action="/listings#results"'), "served form action");
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps the action intact under a hostile query", () => {
    const html = page([alpha], { ...emptyFilters(), q: '\"><img src=x>#elsewhere' });
    ok(!html.includes("><img src=x>"), "reflected query escaped");
    ok(html.includes('<form method="get" action="/listings#results"'), "action intact");
  });
});
