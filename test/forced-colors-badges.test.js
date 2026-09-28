// Forced-colors badge audit pin (TOG-7309, test-only + one-line fix).
//
// Audit result: the eligibility/capability badges (`.badge-*` in
// web/listing-detail.js + web/seller.js) were the one author-colored
// surface with no `forced-colors: active` treatment — focus rings got
// theirs in #137 (TOG-5744), badges did not. Under Windows High Contrast
// the OS flattens author backgrounds to Canvas, so the five badge
// palettes (granted/on green, off grey, blocked red, unknown amber)
// collapse to identical boxes unless a border survives. The fix is one
// rule per layout: `.badge { border: 1px solid CanvasText; }` inside
// `@media (forced-colors: active)` — a 1px system-color outline that
// keeps each badge a distinct chip without overriding the user's theme.
//
// Buttons needed nothing: the CTA/confirm buttons are native `<button>`
// controls, so the OS draws their borders in forced-colors mode by
// default. This file pins both halves: the badge rule ships, and no
// `forced-color-adjust` opt-out defeats the OS mapping anywhere.
//
// node:test, zero dependencies beyond the real renderers. Offline
// (CONTRIBUTING.md: no network in tests; no server fetch here).

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { getStubListing } from "../web/stub-listing.js";
import {
  renderListingDetail,
  renderListingDetailShell,
  renderListingIndex,
} from "../web/listing-detail.js";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import {
  confirmModel,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
} from "../web/seller.js";

// The exact shipped rule (byte-pinned below). `CanvasText` — not a fixed
// hex — so the border follows the user's High Contrast theme, and the
// `.badge` base selector so every variant (on/off/granted/blocked/
// unknown) is covered by one rule.
const BADGE_RULE =
  "@media (forced-colors: active) { .badge { border: 1px solid CanvasText; } }";

// Style-block extraction without tag-stripping replacements (TOG-5717
// CodeQL-safe precedent in test/listing-a11y.test.js): each renderer
// emits exactly one <style> block, located with indexOf — pure
// extraction, no replacement, no HTML-matching regexp.
function styleBlock(html) {
  const open = html.indexOf("<style");
  ok(open !== -1, "shipped <style> block present");
  const openEnd = html.indexOf(">", open);
  const close = html.indexOf("</style>", openEnd);
  ok(openEnd !== -1 && close !== -1, "shipped <style> block closed");
  return html.slice(openEnd + 1, close);
}

// Badge classes rendered on a page, via indexOf scanning (same precedent:
// no regexps). Walks every `class="badge ` occurrence and slices the
// variant token up to the closing quote.
function badgeClasses(html) {
  const found = new Set();
  const marker = 'class="badge ';
  let cursor = 0;
  for (;;) {
    const at = html.indexOf(marker, cursor);
    if (at === -1) {
      break;
    }
    const start = at + marker.length;
    const end = html.indexOf('"', start);
    ok(end !== -1, "badge class attribute closed");
    found.add(html.slice(start, end));
    cursor = end + 1;
  }
  return found;
}

async function sellerPages() {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  const valid = confirmModel(
    validateSellerSubmission(structuredClone(fixtures.valid)),
  );
  const minimal = confirmModel(
    validateSellerSubmission(structuredClone(fixtures.minimal)),
  );
  return {
    confirm: renderSellerConfirm(valid),
    receipt: renderSellerReceipt(valid, "2026-09-27T10:00:00.000Z"),
    missing: renderSellerIntentMissing("northstar", "nope"),
    rejection: renderSellerSubmissionError({
      code: "invalid-submission",
      key: "submission",
      source: "synthetic://wayselect/seller-fixture-v1",
      message: "Invalid seller submission.",
    }),
    minimalConfirm: renderSellerConfirm(minimal),
  };
}

function listingPages() {
  const alpha = getStubListing("northstar", "alpha-chat");
  return {
    shell: renderListingDetailShell(alpha),
    index: renderListingIndex([alpha]),
    granted: renderListingDetail(alpha),
    blocked: renderListingDetail(getStubListing("northstar", "image-lite")),
    unknown: renderListingDetail(getStubListing("northstar", "unknown-tools")),
  };
}

describe("forced-colors badge treatment (TOG-7309)", () => {
  it("ships the badge border rule on every listing and seller page", async () => {
    const pages = { ...listingPages(), ...(await sellerPages()) };
    for (const [name, html] of Object.entries(pages)) {
      ok(
        styleBlock(html).includes(BADGE_RULE),
        `${name}: badge forced-colors rule shipped byte-identical`,
      );
    }
  });

  it("covers every badge variant through the shared .badge base", async () => {
    const pages = { ...listingPages(), ...(await sellerPages()) };
    const seen = new Set();
    for (const html of Object.values(pages)) {
      for (const cls of badgeClasses(html)) {
        seen.add(cls);
      }
    }
    for (const variant of [
      "badge-on",
      "badge-off",
      "badge-granted",
      "badge-blocked",
      "badge-unknown",
    ]) {
      ok(seen.has(variant), `${variant} renders on some pinned page`);
    }
    // The rule targets the base class, not per-variant selectors, so no
    // variant can silently fall out of coverage when a new state is added.
    for (const html of Object.values(pages)) {
      const css = styleBlock(html);
      ok(!css.includes(".badge-on { border"), "no per-variant border split");
      ok(!css.includes(".badge-blocked { border"), "no per-variant border split");
    }
  });

  it("keeps badge meaning in words, not color alone", async () => {
    const pages = listingPages();
    ok(
      pages.granted.includes(
        '<span class="badge badge-granted" aria-label="eligibility: granted">Granted</span>',
      ),
      "granted state named in text + aria-label",
    );
    ok(
      pages.blocked.includes(
        '<span class="badge badge-blocked" aria-label="eligibility: blocked">Blocked</span>',
      ),
      "blocked state named in text + aria-label",
    );
    ok(
      pages.unknown.includes(
        '<span class="badge badge-unknown" aria-label="eligibility: unknown">Unknown</span>',
      ),
      "unknown state named in text + aria-label",
    );
    const seller = await sellerPages();
    ok(
      seller.confirm.includes(
        '<span class="badge badge-blocked" aria-label="eligibility: Blocked">Blocked</span>',
      ),
      "seller confirm verdict named in text + aria-label",
    );
  });

  it("never opts out of the forced-colors mapping", async () => {
    const pages = { ...listingPages(), ...(await sellerPages()) };
    for (const [name, html] of Object.entries(pages)) {
      ok(
        !styleBlock(html).includes("forced-color-adjust"),
        `${name}: no forced-color-adjust opt-out`,
      );
    }
  });

  it("keeps the #137 focus-ring forced-colors fallback intact", async () => {
    const pages = { ...listingPages(), ...(await sellerPages()) };
    for (const [name, html] of Object.entries(pages)) {
      ok(
        styleBlock(html).includes("(forced-colors: active)"),
        `${name}: forced-colors block present`,
      );
      ok(
        styleBlock(html).includes("outline: 3px solid Highlight;"),
        `${name}: focus-ring Highlight fallback kept`,
      );
    }
  });
});
