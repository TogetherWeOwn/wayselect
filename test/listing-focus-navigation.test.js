// Tests for TOG-6393 (Gap A2): focus management on listing navigation.
//
// Full-page filter/page changes are plain GET navigations, so the browser
// resets focus to the document on every submit and every Prev/Next click —
// the disposition was unpinned. This file pins the server-rendered contract
// that fixes it, without touching the TOG-6051 live-region announcement:
//   - the filter form submits to the bare index action with the in-page
//     `#results` fragment, so the fresh page lands with focus context at
//     the results section (keyboard/SR users are not dropped at the top);
//   - the rendered results `<section>` is the focus target (`id="results"`,
//     `tabindex="-1"`, same programmatic-focus pattern as `#main-content`)
//     on populated, filter-miss, and offset-past-end renders alike;
//   - Prev/Next and Back-to-first-page links preserve filters/sort/paging
//     and carry the same `#results` fragment;
//   - the `role="status"` live region keeps its exact TOG-6051 shape (one
//     polite announcer, no focus handling) — announcement stays separate
//     from focus.
// (node:test, zero dependencies.)

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { emptyFilters } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { getStubListing } from "../web/stub-listing.js";
import { createApp } from "../web/server.js";

// Index renders that carry no evaluations: pass an explicit empty map so
// the focus contract never depends on eligibility resolution.
const NO_EVALUATIONS = new Map();

function listingRow(providerId, modelId) {
  return {
    providerId,
    modelId,
    providerName: providerId,
    entry: { name: `${providerId} ${modelId}` },
  };
}

// Every `<a>` on the page as `{ href, label }`, in document order. Labels
// are bare text in this renderer, so capture up to the closing tag.
function anchors(html) {
  return [...html.matchAll(/<a\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const href = tag.match(/href="([^"]*)"/)?.[1] ?? null;
    const rest = html.slice(match.index + tag.length);
    const label = rest.slice(0, rest.indexOf("</a>"));
    return { href, label };
  });
}

function resultsSection(html) {
  const open = '<section aria-label="Results"';
  const start = html.indexOf(open);
  ok(start !== -1, "results section rendered");
  const end = html.indexOf("</section>", start);
  ok(end !== -1, "results section closed");
  return html.slice(start, end + "</section>".length);
}

describe("listing focus management (TOG-6393)", () => {
  it("submits the filter form to the bare index action with the results fragment", () => {
    const html = renderListingIndex(
      [getStubListing("northstar", "alpha-chat")],
      NO_EVALUATIONS,
      emptyFilters(),
    );
    // Byte-identical action: no query state rides along, so a stale or
    // hostile query string can never corrupt the submit target.
    ok(html.includes('<form method="get" action="/listings#results"'), "form action pins fragment");
    ok(html.includes('aria-label="Filter listings"'), "accessible form name kept");
    // Named input focus stays where the user typed: search, sort, submit.
    ok(html.includes('id="filter-q" name="q"'), "search input identity kept");
    ok(html.includes('id="filter-sort" name="sort"'), "sort select identity kept");
    ok(html.includes('<button type="submit">Apply filters</button>'), "named submit kept");
  });

  it("makes the results section the focus target on every render state", () => {
    const alpha = getStubListing("northstar", "alpha-chat");
    const renders = {
      populated: renderListingIndex([alpha], NO_EVALUATIONS, emptyFilters()),
      "filter-miss": renderListingIndex([], NO_EVALUATIONS, emptyFilters()),
      "past-the-end": renderListingIndex([], NO_EVALUATIONS, emptyFilters(), {
        total: 3,
        limit: 5,
        offset: 10,
      }),
    };
    for (const [state, html] of Object.entries(renders)) {
      const section = resultsSection(html);
      ok(section.includes('id="results"'), `${state}: results section has the focus id`);
      ok(section.includes('tabindex="-1"'), `${state}: focus target, out of the tab order`);
      // The TOG-6051 announcer is untouched: exactly one polite live
      // region, and it carries no focus handling of its own.
      const live = [...section.matchAll(/<p role="status" aria-live="polite">/g)];
      strictEqual(live.length, 1, `${state}: exactly one polite live region`);
      const statusTag = section.match(/<p role="status"[^>]*>/)?.[0] ?? "";
      ok(!statusTag.includes("tabindex"), `${state}: live region takes no focus`);
      ok(!statusTag.includes('id="'), `${state}: live region takes no id`);
    }
    // One focus target per page: duplicate ids would break the fragment.
    for (const [state, html] of Object.entries(renders)) {
      const ids = [...html.matchAll(/id="results"/g)];
      strictEqual(ids.length, 1, `${state}: exactly one #results target`);
    }
  });

  it("lands page navigation on the results section without dropping state", () => {
    const rows = Array.from({ length: 6 }, (_, i) => listingRow("synth", `m${i}`));
    const filters = { ...emptyFilters(), q: "synth", sort: "price-asc" };
    const mid = renderListingIndex(rows.slice(0, 5), NO_EVALUATIONS, filters, {
      total: 6,
      limit: 5,
      offset: 0,
    });
    const next = anchors(mid).find((a) => a.label === "Next");
    ok(next, "next link rendered");
    ok(next.href.includes("q=synth"), "next preserves the text filter");
    ok(next.href.includes("sort=price-asc"), "next preserves the explicit sort");
    ok(next.href.includes("offset=5"), "next advances the window");
    ok(next.href.endsWith("#results"), "next lands on the results section");

    const late = renderListingIndex(rows.slice(5), NO_EVALUATIONS, filters, {
      total: 6,
      limit: 5,
      offset: 5,
    });
    const prev = anchors(late).find((a) => a.label === "Previous");
    ok(prev, "previous link rendered");
    ok(prev.href.endsWith("#results"), "previous lands on the results section");

    // Offset past the end: the recovery link restarts at the first page
    // with the filters intact, on the same focus target.
    const pastEnd = renderListingIndex([], NO_EVALUATIONS, filters, {
      total: 6,
      limit: 5,
      offset: 10,
    });
    const back = anchors(pastEnd).find((a) => a.label === "Back to first page");
    ok(back, "recovery link rendered");
    ok(!back.href.includes("offset="), "recovery restarts at the first page");
    ok(back.href.includes("q=synth"), "recovery keeps the text filter");
    ok(back.href.endsWith("#results"), "recovery lands on the results section");
  });

  it("keeps the served filtered page on the focus contract", async () => {
    const servers = [];
    const start = async (env) => {
      const server = createApp(env);
      servers.push(server);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    };
    try {
      const base = await start({ WAYSELECT_PREVIEW: "1" });
      const res = await fetch(`${base}/listings?q=alpha`);
      strictEqual(res.status, 200);
      const html = await res.text();
      ok(html.includes('<form method="get" action="/listings#results"'), "served form action");
      ok(
        html.includes('<section aria-label="Results" id="results" tabindex="-1">'),
        "served results focus target",
      );
    } finally {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    }
  });

  it("keeps the form action byte-identical under a hostile q", () => {
    const html = renderListingIndex([getStubListing("northstar", "alpha-chat")], NO_EVALUATIONS, {
      ...emptyFilters(),
      q: `"><img src=x>`,
    });
    ok(!html.includes("><img src=x>"), "hostile q escaped");
    ok(html.includes('<form method="get" action="/listings#results"'), "action intact");
  });
});
