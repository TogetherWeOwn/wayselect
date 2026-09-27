// Tests for TOG-5744: visible-focus + reduced-motion polish on the listing
// pages. The loading shell already shipped with a skeleton pulse disabled
// under `prefers-reduced-motion` (TOG-5717); this pass extends the
// reduced-motion block to the skip-link slide transition, brings the seller
// confirm/receipt pages to focus-ring parity (links, buttons, AND inputs),
// and pins that default (full-motion) rendering keeps the pulse animation.
// (node:test, zero dependencies.)

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { getStubListing } from "../web/stub-listing.js";
import {
  renderListingDetailShell,
  renderListingIndex,
} from "../web/listing-detail.js";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import { confirmModel, renderSellerConfirm } from "../web/seller.js";

async function sellerHtml() {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  return renderSellerConfirm(
    confirmModel(validateSellerSubmission(structuredClone(fixtures.valid))),
  );
}

describe("listing focus + reduced-motion polish (TOG-5744)", () => {
  it("kills every transition/animation under prefers-reduced-motion on listing pages", () => {
    const html = renderListingDetailShell(
      getStubListing("northstar", "alpha-chat"),
    );
    ok(html.includes("@media (prefers-reduced-motion: reduce)"), "reduced-motion block");
    ok(html.includes(".skeleton { animation: none; }"), "skeleton pulse disabled");
    ok(html.includes(".skip-link { transition: none; }"), "skip-link slide disabled");
    const index = renderListingIndex([getStubListing("northstar", "alpha-chat")]);
    ok(index.includes(".skip-link { transition: none; }"), "index page too");
  });

  it("keeps the skeleton pulse in default (full-motion) rendering", () => {
    const html = renderListingDetailShell(
      getStubListing("northstar", "alpha-chat"),
    );
    ok(html.includes("animation: skeleton-pulse"), "pulse runs by default");
    ok(html.includes("@keyframes skeleton-pulse"), "keyframes defined");
  });

  it("covers links, buttons, and inputs with focus-visible on every listing page", async () => {
    const pages = [
      renderListingDetailShell(getStubListing("northstar", "alpha-chat")),
      renderListingIndex([getStubListing("northstar", "alpha-chat")]),
      await sellerHtml(),
    ];
    for (const html of pages) {
      ok(html.includes("a:focus-visible"), "link focus ring");
      ok(html.includes("button:focus-visible"), "button focus ring");
      ok(html.includes("input:focus-visible"), "input focus ring");
      ok(html.includes("(forced-colors: active)"), "high-contrast fallback");
      ok(
        html.includes("input:focus-visible { outline: 3px solid Highlight; }"),
        "forced-colors covers inputs",
      );
    }
  });
});
