// Tests for TOG-9168 (round-6 gap): listing `q` filter unicode behavior
// (test-only). `applyListingsFilters` folds the query with `trim().toLowerCase()`
// only (web/filter.js `matchesText`): it performs NO NFC/NFKC normalization and
// NO full casefold. These tests pin that contract with confusable inputs, so a
// future change to normalize unicode fails loudly instead of shipping silently.

import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { applyListingsFilters, emptyFilters } from "../web/filter.js";

const ACCENTED = [
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "uno",
    entry: { name: "Café Corner" },
  },
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "dos",
    entry: { name: "Straße Maps" },
  },
  {
    providerId: "acme",
    providerName: "Acme",
    modelId: "tres",
    entry: { name: "ﬁle Viewer" },
  },
];

function modelIds(listings) {
  return listings.map((listing) => listing.modelId);
}

function match(q) {
  return modelIds(applyListingsFilters(ACCENTED, { ...emptyFilters(), q }));
}

describe("filter q unicode normalization contract (TOG-9168)", () => {
  it("does NOT NFC-normalize: NFD decomposed query misses the NFC haystack", () => {
    // "café" (NFC, U+00E9) matches; "café" (NFD, e + combining acute)
    // is canonically equivalent but NOT matched — no NFC normalization.
    deepStrictEqual(match("café"), ["uno"]);
    deepStrictEqual(match("café"), []);
  });

  it("folds ASCII case via toLowerCase but does NOT casefold ß to ss", () => {
    // Plain case differences match, but "strasse" does NOT match "Straße":
    // toLowerCase never expands ß, a full casefold would.
    deepStrictEqual(match("CAFÉ CORNER"), ["uno"]);
    deepStrictEqual(match("straße"), ["dos"]);
    deepStrictEqual(match("STRAẞE MAPS"), ["dos"]);
    deepStrictEqual(match("strasse"), []);
  });

  it("does NOT NFKC-normalize compatibility characters", () => {
    // Fullwidth "ｃafé" (U+FF43) is NFKC-equivalent to "café" but NOT matched.
    // The ﬁ ligature (U+FB01) only matches itself byte-identically.
    deepStrictEqual(match("ｃafé"), []);
    deepStrictEqual(match("ﬁle"), ["tres"]);
    deepStrictEqual(match("file"), []);
    deepStrictEqual(match("FILE"), []);
  });
});
