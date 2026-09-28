// TOG-7292: empty-q vs missing-q filter contract pin (test-only).
//
// Gap: /listings never pinned whether `?q=` (present-but-empty) behaves the
// same as an absent `q`. Pinned behavior (verified 2026-09-28 against
// `parseListingsQuery` + `applyListingsFilters` + the served index): all
// three spellings — absent `q`, `?q=`, bare `?q` — parse `ok:true` with
// identical filters (`q: ""`), match the full stub catalog in stub order,
// and serve 200 index pages with identical bodies (modulo the per-response
// CSP nonce, TOG-6049).
//
// node:test, zero dependencies, stub fixtures only.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  applyListingsFilters,
  emptyFilters,
  parseListingsQuery,
} from "../web/filter.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";
import { createApp } from "../web/server.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

function modelIds(listings) {
  return listings.map((listing) => listing.modelId);
}

describe("empty-q vs missing-q filter contract (TOG-7292)", () => {
  it("parses absent q, ?q=, and bare ?q to identical ok filters with q: ''", () => {
    const absent = parseListingsQuery(params(""));
    const empty = parseListingsQuery(params("?q="));
    const bare = parseListingsQuery(params("?q"));
    for (const [label, parsed] of [
      ["absent q", absent],
      ["?q=", empty],
      ["bare ?q", bare],
    ]) {
      strictEqual(parsed.ok, true, `${label} parses ok`);
      strictEqual(parsed.filters.q, "", `${label} yields q: ""`);
    }
    deepStrictEqual(empty.filters, absent.filters, "?q= filters equal absent-q filters");
    deepStrictEqual(bare.filters, absent.filters, "bare ?q filters equal absent-q filters");
    deepStrictEqual(absent.filters, emptyFilters(), "absent q matches emptyFilters()");
  });

  it("matches the full catalog in stub order for every empty-q spelling", () => {
    const expected = modelIds(STUB_LISTINGS);
    for (const query of ["", "?q=", "?q"]) {
      const parsed = parseListingsQuery(params(query));
      strictEqual(parsed.ok, true, `${query || "(absent)"} parses ok`);
      deepStrictEqual(
        modelIds(applyListingsFilters(STUB_LISTINGS, parsed.filters)),
        expected,
        `${query || "(absent)"} matches every listing in stub order`,
      );
    }
  });

  it("serves identical 200 index bodies for absent q and ?q= (nonce-normalized)", async () => {
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    // TOG-6049: every HTML response mints a fresh CSP nonce, so two
    // responses never compare byte-identical. Normalize nonces first.
    const stripNonces = (html) => html.replaceAll(/ nonce="[^"]*"/g, "");
    const absentRes = await fetch(`${base}/listings`);
    const emptyRes = await fetch(`${base}/listings?q=`);
    strictEqual(absentRes.status, 200, "GET /listings");
    strictEqual(emptyRes.status, 200, "GET /listings?q=");
    const absentHtml = await absentRes.text();
    const emptyHtml = await emptyRes.text();
    strictEqual(
      stripNonces(emptyHtml),
      stripNonces(absentHtml),
      "?q= serves the same index body as absent q",
    );
    ok(absentHtml.includes('name="q" value=""'), "empty q reflected as empty input");
  });
});
