// Tests for TOG-5717: aria-live shell announcer, visible focus states, and
// semantic landmarks on the listing index + detail pages (node:test, zero
// dependencies).

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetailShell, renderListingIndex } from "../web/listing-detail.js";

describe("listing a11y shell (TOG-5717)", () => {
  it("announces loading state via a dedicated role=status live region", () => {
    const html = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(html.includes('id="listing-detail-status"'), "status announcer present");
    ok(html.includes('role="status"'), "status role announces politely");
    ok(html.includes("Listing details loaded."), "loaded announcement scripted");
    // The skeleton chrome stays silent so SR users hear one announcement.
    const chrome = html
      .replaceAll(/<noscript>[\s\S]*?<\/noscript>/gi, "")
      .replaceAll(/<script>[\s\S]*?<\/script>/gi, "");
    ok(!chrome.includes('aria-live="polite"'), "no duplicate live region in chrome");
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
    ok(one.includes('aria-label="Results"'), "results landmark");
    ok(one.includes("1 listing found."), "singular count announced");
    const empty = renderListingIndex([]);
    ok(empty.includes('role="status"'), "empty state announced");
    ok(empty.includes("No listings match these filters."), "empty copy kept");
  });
});
