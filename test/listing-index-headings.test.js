// Tests for TOG-6392: index heading-hierarchy audit (node:test, zero
// dependencies).
//
// Gap A1: the detail page ships an audited h1 + h2 sections structure
// (Eligibility, Capabilities, List-price estimate) with skip link + lang,
// but the index page's single-h1/section structure was never audited. This
// file pins the audited index hierarchy on every index state:
//   - exactly one h1 ("Listings"), then exactly two h2s in order:
//     "Filter listings" (filter section) and "Results" (results section);
//   - both sections are labelledby-sections whose refs resolve to the
//     visible h2, so the accessible names ("Filter listings", "Results")
//     match what sighted users see — no aria-label-only sections;
//   - no skipped levels: no h3-h6 anywhere on the index;
//   - the same hierarchy on the served GET /listings route (flag-gated 200
//     path), not just the renderer.
// Heading extraction uses matchAll/includes only — no tag-stripping
// replacement (CodeQL js/incomplete-multi-character-sanitization precedent
// from test/listing-a11y.test.js).

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { emptyFilters } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";
import { STUB_LISTINGS, getStubListing } from "../web/stub-listing.js";

const FILTER_HEADING = '<h2 id="filter-heading">Filter listings</h2>';
const RESULTS_HEADING = '<h2 id="results-heading">Results</h2>';

function headings(html) {
  return [...html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map((match) => ({
    level: Number(match[1]),
    text: match[2],
  }));
}

function assertAuditedHierarchy(html, label) {
  const found = headings(html);
  // Exactly one h1, then exactly the two audited h2s in order.
  strictEqual(
    found.filter((h) => h.level === 1).length,
    1,
    `${label}: single h1`,
  );
  strictEqual(found[0].text, "Listings", `${label}: h1 copy`);
  const h2s = found.filter((h) => h.level === 2);
  strictEqual(h2s.length, 2, `${label}: exactly two h2s, got ${JSON.stringify(h2s)}`);
  strictEqual(h2s[0].text, "Filter listings", `${label}: filter h2 first`);
  strictEqual(h2s[1].text, "Results", `${label}: results h2 second`);
  // No skipped levels anywhere on the page.
  ok(
    found.every((h) => h.level <= 2),
    `${label}: no h3-h6`,
  );
  // Labelledby refs resolve to the visible headings; accessible names match.
  ok(html.includes('<section aria-labelledby="filter-heading">'), `${label}: filter section labelled`);
  ok(html.includes(FILTER_HEADING), `${label}: filter heading visible`);
  ok(html.includes('<section aria-labelledby="results-heading" id="results" tabindex="-1">'), `${label}: results section labelled`);
  ok(html.includes(RESULTS_HEADING), `${label}: results heading visible`);
  strictEqual(
    (html.match(/id="filter-heading"/g) ?? []).length,
    1,
    `${label}: filter-heading id unique`,
  );
  strictEqual(
    (html.match(/id="results-heading"/g) ?? []).length,
    1,
    `${label}: results-heading id unique`,
  );
  // Filter section precedes results section in document order.
  ok(
    html.indexOf(FILTER_HEADING) < html.indexOf(RESULTS_HEADING),
    `${label}: filter section before results section`,
  );
}

describe("index heading hierarchy (TOG-6392)", () => {
  it("audits the populated index: h1 Listings + h2 Filter/Results", () => {
    assertAuditedHierarchy(
      renderListingIndex([getStubListing("northstar", "alpha-chat")]),
      "populated",
    );
  });

  it("audits the empty-filter index: hierarchy kept with no result list", () => {
    const html = renderListingIndex([], undefined, emptyFilters());
    assertAuditedHierarchy(html, "empty");
    ok(html.includes("No listings match these filters."), "empty copy kept");
  });

  it("audits the past-the-end page: hierarchy kept on the empty window", () => {
    const html = renderListingIndex([], undefined, emptyFilters(), {
      total: 10,
      limit: 5,
      offset: 10,
    });
    assertAuditedHierarchy(html, "past-end");
    ok(html.includes("No listings on this page."), "empty-window copy kept");
  });

  it("audits the windowed page: hierarchy kept with prev/next nav", () => {
    const html = renderListingIndex([...STUB_LISTINGS], undefined, emptyFilters(), {
      total: STUB_LISTINGS.length,
      limit: 1,
      offset: 1,
    });
    assertAuditedHierarchy(html, "windowed");
  });

  it("keeps the filter form's accessible name and controls under the new section", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(html.includes('role="search"'), "search landmark role kept");
    ok(html.includes('aria-label="Filter listings"'), "form accessible name kept");
    ok(html.includes('id="filter-q"'), "search input kept");
    ok(html.includes("<legend>Capabilities</legend>"), "capabilities legend kept");
    ok(html.includes("<legend>Modalities</legend>"), "modalities legend kept");
  });
});

describe("index heading hierarchy over HTTP (TOG-6392)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the audited hierarchy on GET /listings", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    assertAuditedHierarchy(await res.text(), "served index");
  });

  it("serves the audited hierarchy on the empty-result page", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=zzz-no-such-listing`);
    strictEqual(res.status, 200);
    const html = await res.text();
    assertAuditedHierarchy(html, "served empty");
    ok(html.includes("No listings match these filters."), "empty copy kept");
  });
});
