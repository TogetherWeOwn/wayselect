// Tests for TOG-8616: every listing/detail table carries a <caption> and
// proper column <th scope="col"> headers alongside the existing row
// headers (scope="row"). Covers the listing-detail page (Capabilities +
// List-price estimate) and the seller confirm, receipt, and rejection
// surfaces (node:test, zero dependencies).

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetail } from "../web/listing-detail.js";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import {
  confirmModel,
  renderSellerConfirm,
  renderSellerReceipt,
  renderSellerSubmissionError,
} from "../web/seller.js";

function tables(html) {
  return [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((match) => match[1]);
}

function checkTableHeaders(html, page) {
  const found = tables(html);
  ok(found.length > 0, `${page} renders at least one table`);
  for (const table of found) {
    ok(table.includes("<caption>"), `${page}: table carries a <caption>`);
    ok(table.includes('<th scope="col">'), `${page}: table carries column <th scope="col">`);
    ok(table.includes('<th scope="row">'), `${page}: row headers scope="row" kept`);
  }
  return found.length;
}

async function sellerModel() {
  const fixtures = JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
  return confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));
}

describe("listing table captions + column headers (TOG-8616)", () => {
  it("listing detail tables gain caption + column headers", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    const count = checkTableHeaders(html, "listing detail");
    ok(count === 2, `detail renders 2 tables, got ${count}`);
    ok(html.includes("<caption>Capabilities</caption>"), "capabilities caption");
    ok(html.includes("<caption>List-price estimate</caption>"), "price caption");
  });

  it("seller confirm tables gain caption + column headers", async () => {
    const html = renderSellerConfirm(await sellerModel());
    const count = checkTableHeaders(html, "seller confirm");
    ok(count === 2, `confirm renders 2 tables, got ${count}`);
  });

  it("seller receipt table gains caption + column headers", async () => {
    const html = renderSellerReceipt(await sellerModel(), "2026-01-01T00:00:00Z");
    const count = checkTableHeaders(html, "seller receipt");
    ok(count === 1, `receipt renders 1 table, got ${count}`);
  });

  it("seller rejection table gains caption + column headers", () => {
    const html = renderSellerSubmissionError({});
    const count = checkTableHeaders(html, "seller rejection");
    ok(count === 1, `rejection renders 1 table, got ${count}`);
  });
});
