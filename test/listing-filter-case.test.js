// Tests for TOG-6720 (round-4 gap R4-14): filter text-match case behavior
// (test-only). `applyListingsFilters` folds both the query and the haystacks
// (name, route, provider) with `toLowerCase`, so matching is case-insensitive;
// only one all-caps query ("ALPHA") pinned that. These tests pin the exact
// match set for mixed-case `q` against the mixed-case stub names, so a future
// flip to case-sensitive matching fails loudly instead of shipping silently.

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyListingsFilters,
  emptyFilters,
  parseListingsQuery,
} from "../web/filter.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function modelIds(listings) {
  return listings.map((listing) => listing.modelId);
}

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

describe("filter text-match case behavior (TOG-6720)", () => {
  it("matches mixed-case q against mixed-case names with exact match sets", () => {
    const cases = [
      ["aLpHa ChAt", ["alpha-chat"]],
      ["ALPHA CHAT", ["alpha-chat"]],
      ["alpha chat", ["alpha-chat"]],
      ["AlPhA", ["alpha-chat"]],
      ["  AlPhA  ", ["alpha-chat"]],
      ["IMAGE lite", ["image-lite"]],
      ["uNkNoWn tOoLs", ["unknown-tools"]],
      ["NorthStar/IMAGE-lite", ["image-lite"]],
      ["nOrThStAr", ["alpha-chat", "image-lite", "unknown-tools"]],
      ["SYNTHETIC provider", ["alpha-chat", "image-lite", "unknown-tools"]],
      ["CHAT", ["alpha-chat"]],
      ["ALPHA!", []],
      ["ZzZ No SuCh LiStInG", []],
    ];
    for (const [q, expected] of cases) {
      deepStrictEqual(
        modelIds(applyListingsFilters(STUB_LISTINGS, { ...emptyFilters(), q })),
        expected,
        `q=${JSON.stringify(q)}`,
      );
    }
  });

  it("returns identical sets for every case variant of one term", () => {
    const sets = ["alpha", "ALPHA", "AlPhA", "aLpHa", " ALPHA "].map((q) =>
      modelIds(applyListingsFilters(STUB_LISTINGS, { ...emptyFilters(), q })),
    );
    for (const set of sets) {
      deepStrictEqual(set, ["alpha-chat"]);
    }
  });

  it("keeps q verbatim at parse time; folding happens at match time", () => {
    const parsed = parseListingsQuery(params(`?q=${encodeURIComponent("aLpHa ChAt")}`));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.filters.q, "aLpHa ChAt");
    deepStrictEqual(modelIds(applyListingsFilters(STUB_LISTINGS, parsed.filters)), [
      "alpha-chat",
    ]);
  });
});
