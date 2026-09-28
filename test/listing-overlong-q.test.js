// Overlong-q fail-closed pin (TOG-7296, test-only).
//
// `q` beyond LISTINGS_MAX_QUERY_LENGTH fails closed: `parseListingsQuery`
// returns ok:false with kind "q", the echoed value is exactly the first 64
// input characters (`filters.q.slice(0, 64)` in web/filter.js), and the
// `valid` entry names the bound byte-for-byte. The 400 page renders the same
// bytes (`renderInvalidFilter` single-error paragraph), never the full
// input. The acceptance bar is exact bytes, not a length bound.
//
// No source change: web/filter.js already truncates at 64 and
// web/listing-detail.js renders the single-error paragraph verbatim.
// This file pins those bytes so a future bound/echo change fails loudly.
//
// node:test, zero dependencies beyond the real filter + renderer. Offline
// (CONTRIBUTING.md: no network in tests; no server fetch here, the live
// 400 route is already pinned in test/listing-empty-error-states.test.js).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { LISTINGS_MAX_QUERY_LENGTH, parseListingsQuery } from "../web/filter.js";
import { renderInvalidFilter } from "../web/listing-detail.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

describe("overlong-q fail-closed pin (TOG-7296)", () => {
  it("pins the q bound the exact bytes are built against", () => {
    strictEqual(LISTINGS_MAX_QUERY_LENGTH, 200);
  });

  it("echoes exactly the first 64 chars for q at bound+1 (fail-closed)", () => {
    const q = "a".repeat(LISTINGS_MAX_QUERY_LENGTH + 1);
    const parsed = parseListingsQuery(params(`?q=${encodeURIComponent(q)}`));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "q");
    strictEqual(parsed.value, "a".repeat(64));
    deepStrictEqual(parsed.valid, ["at most 200 characters"]);
    deepStrictEqual(parsed.errors, [
      { kind: "q", value: "a".repeat(64), valid: ["at most 200 characters"] },
    ]);
  });

  it("echoes exactly the first 64 chars for a 10k-char q (page stays bounded)", () => {
    const parsed = parseListingsQuery(params(`?q=${"b".repeat(10000)}`));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "q");
    strictEqual(parsed.value, "b".repeat(64));
    deepStrictEqual(parsed.valid, ["at most 200 characters"]);
  });

  it("renders the 400 paragraph with the exact truncated echo, never the full input", () => {
    const q = "a".repeat(LISTINGS_MAX_QUERY_LENGTH + 1);
    const parsed = parseListingsQuery(params(`?q=${encodeURIComponent(q)}`));
    const html = renderInvalidFilter(parsed);
    const expected =
      `<p>Unknown q &quot;${"a".repeat(64)}&quot;. ` +
      `Valid values: at most 200 characters.</p>`;
    ok(html.includes(expected), `400 page carries the exact echo bytes, got:\n${html}`);
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(!html.includes(q), "full overlong input never echoed");
    ok(!html.includes("a".repeat(65)), "no more than 64 echo chars");
  });
});
