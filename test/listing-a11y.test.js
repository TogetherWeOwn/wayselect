// Tests for TOG-5717: aria-live shell announcer, visible focus states, and
// semantic landmarks on the listing index + detail pages (node:test, zero
// dependencies).

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetailShell, renderListingIndex } from "../web/listing-detail.js";

// Shell-chrome segments outside the <noscript>/<script> blocks (TOG-6049,
// TOG-6028 CodeQL-safe precedent): CodeQL flags generic tag-strip
// replaceAll as incomplete multi-character sanitization plus bad HTML
// filtering regexp, even in tests. Locate the single <noscript> and
// <script> blocks with indexOf and return the segments outside them —
// pure extraction, no tag-stripping replacement. Sound here: the renderer
// emits exactly one of each, lowercase, with escaped attrs (no raw `>`
// can hide inside the opening tag).
function chromeSegments(html) {
  const segments = [];
  let cursor = 0;
  while (cursor < html.length) {
    const nosOpen = html.indexOf("<noscript>", cursor);
    const scriptOpen = html.indexOf("<script", cursor);
    let open = -1;
    let tag = null;
    if (nosOpen !== -1 && (scriptOpen === -1 || nosOpen < scriptOpen)) {
      open = nosOpen;
      tag = "noscript";
    } else if (scriptOpen !== -1) {
      open = scriptOpen;
      tag = "script";
    } else {
      segments.push(html.slice(cursor));
      break;
    }
    segments.push(html.slice(cursor, open));
    const closeTag = `</${tag}>`;
    const close = html.indexOf(closeTag, open);
    if (close === -1) {
      break;
    }
    cursor = close + closeTag.length;
  }
  return segments;
}

describe("listing a11y shell (TOG-5717)", () => {
  it("announces loading state via a dedicated role=status live region", () => {
    const html = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(html.includes('id="listing-detail-status"'), "status announcer present");
    ok(html.includes('role="status"'), "status role announces politely");
    ok(html.includes("Listing details loaded."), "loaded announcement scripted");
    // The skeleton chrome stays silent so SR users hear one announcement.
    ok(
      chromeSegments(html).every((seg) => !seg.includes('aria-live="polite"')),
      "no duplicate live region in chrome",
    );
  });

  it("moves focus to retry when the fragment fetch fails", () => {
    const html = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(html.includes("retry.focus()"), "error path focuses retry");
  });

  it("exposes header/nav/main/footer landmarks plus a skip link on every page", () => {
    for (const html of [
      renderListingDetailShell(getStubListing("northstar", "alpha-chat")),
      renderListingIndex([getStubListing("northstar", "alpha-chat")]),
    ]) {
      ok(html.includes('class="skip-link"'), "skip link");
      ok(html.includes('href="#main-content"'), "skip target");
      ok(html.includes("<header"), "header landmark");
      ok(html.includes('aria-label="Primary"'), "primary nav label");
      ok(html.includes('id="main-content"'), "main target");
      ok(html.includes("<footer"), "footer landmark");
    }
    // One <h1> per page: no landmark heading duplication.
    const indexH1 = renderListingIndex([getStubListing("northstar", "alpha-chat")]).match(/<h1>/g) ?? [];
    ok(indexH1.length === 1, "single h1 on index");
  });

  it("defines visible focus states that survive forced-colors mode", () => {
    const html = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(html.includes(":focus-visible"), "focus-visible styles");
    ok(html.includes("(forced-colors: active)"), "high-contrast fallback");
    ok(html.includes(".visually-hidden"), "screen-reader-only helper");
  });

  it("announces index result counts in a labelled results section", () => {
    const one = renderListingIndex([getStubListing("northstar", "alpha-chat")]);
    // TOG-6392: the results section is a labelledby section with a visible
    // h2 heading (accessible name stays "Results") — the audited hierarchy.
    ok(one.includes('aria-labelledby="results-heading"'), "results landmark");
    ok(one.includes('<h2 id="results-heading">Results</h2>'), "visible results heading");
    ok(one.includes("1 listing found."), "singular count announced");
    const empty = renderListingIndex([]);
    ok(empty.includes('role="status"'), "empty state announced");
    ok(empty.includes("No listings match these filters."), "empty copy kept");
  });

  it("marks the index result count as a polite live region that updates on filter change", () => {
    // TOG-6051 (Gap A1, part 2): the result-count paragraph carries an
    // explicit aria-live="polite" so the announcement fires when the filter
    // form re-renders the index — role="status" alone only implies it.
    const renders = [
      renderListingIndex([getStubListing("northstar", "alpha-chat")]),
      renderListingIndex([]),
      // Over-offset empty page: same live region, distinct copy.
      renderListingIndex([], undefined, undefined, { total: 3, limit: 5, offset: 10 }),
    ];
    const announcements = [];
    for (const html of renders) {
      const live = [...html.matchAll(/<p role="status" aria-live="polite">([^<]*)<\/p>/g)].map(
        (match) => match[1],
      );
      ok(live.length === 1, `exactly one polite live region, got ${live.length}`);
      announcements.push(live[0]);
    }
    ok(announcements[0].includes("1 listing found."), "populated count announced");
    ok(
      announcements[1].includes("No listings match these filters."),
      "filter-miss count announced",
    );
    ok(announcements[2].includes("No listings on this page."), "empty-page count announced");
    ok(
      new Set(announcements).size === announcements.length,
      "announcement text changes between filter states",
    );
  });
});
