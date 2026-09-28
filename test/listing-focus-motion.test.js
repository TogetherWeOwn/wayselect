// Tests for TOG-5744: visible-focus + reduced-motion polish on the listing
// pages. The loading shell already shipped with a skeleton pulse disabled
// under `prefers-reduced-motion` (TOG-5717); this pass extends the
// reduced-motion block to the skip-link slide transition, brings the seller
// confirm/receipt pages to focus-ring parity (links, buttons, AND inputs),
// and pins that default (full-motion) rendering keeps the pulse animation.
// TOG-8331 extends the reduced-motion pin to every preview renderer: the
// audit found no offenders (both layouts already guard), so this test pins
// all twelve pages — eight listing renderers plus four seller renderers —
// so a new transition or a new page cannot regress silently.
// (node:test, zero dependencies.)

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { getStubListing } from "../web/stub-listing.js";
import {
  renderInvalidFilter,
  renderListingDetail,
  renderListingDetailError,
  renderListingIndex,
  renderListingDetailShell,
  renderNotFound,
  renderPreviewDisabled,
  renderRouteNotFound,
} from "../web/listing-detail.js";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import {
  confirmModel,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
} from "../web/seller.js";

async function sellerModel() {
  const fixtures = JSON.parse(
    await readFile(
      new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
      "utf8",
    ),
  );
  return confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));
}

async function sellerHtml() {
  return renderSellerConfirm(await sellerModel());
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

  it("kills the skip-link slide under prefers-reduced-motion on every preview page (TOG-8331)", async () => {
    const listing = getStubListing("northstar", "alpha-chat");
    const model = await sellerModel();
    const pages = {
      "detail shell": renderListingDetailShell(listing),
      "detail full": renderListingDetail(listing),
      "detail error": renderListingDetailError("northstar", "alpha-chat"),
      "detail miss": renderNotFound("northstar", "nope"),
      "route 404": renderRouteNotFound("/nope"),
      "preview disabled": renderPreviewDisabled(),
      "invalid filter": renderInvalidFilter({ kind: "capability", value: "nope", valid: ["chat"] }),
      index: renderListingIndex([listing]),
      "seller confirm": renderSellerConfirm(model),
      "seller receipt": renderSellerReceipt(model, "2026-09-27T10:00:00.000Z"),
      "seller intent missing": renderSellerIntentMissing("northstar", "nope"),
      "seller error": renderSellerSubmissionError({ code: "x", key: "k", source: "s" }),
    };
    for (const [name, html] of Object.entries(pages)) {
      ok(html.includes("@media (prefers-reduced-motion: reduce)"), `${name}: reduced-motion block`);
      ok(html.includes(".skip-link { transition: none; }"), `${name}: skip-link slide disabled`);
    }
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
