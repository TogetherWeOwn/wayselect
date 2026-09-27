// Tests for the TOG-5459 storefront filter-bar slice: query parsing, filter
// matching, and index rendering (node:test, zero dependencies).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LISTINGS_MAX_QUERY_LENGTH,
  VALID_CAPABILITIES,
  VALID_LISTINGS_QUERY_PARAMS,
  VALID_MODALITIES,
  applyListingsFilters,
  emptyFilters,
  parseListingsQuery,
} from "../web/filter.js";
import { renderInvalidFilter, renderListingIndex } from "../web/listing-detail.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

describe("parseListingsQuery", () => {
  it("parses empty params to empty filters", () => {
    const parsed = parseListingsQuery(params(""));
    strictEqual(parsed.ok, true);
    deepStrictEqual(parsed.filters, { q: "", capabilities: [], modalities: [] });
  });

  it("parses q plus repeatable capability/modality params", () => {
    const parsed = parseListingsQuery(
      params("?q=alpha&capability=tool_call&capability=reasoning&modality=image"),
    );
    strictEqual(parsed.ok, true);
    deepStrictEqual(parsed.filters, {
      q: "alpha",
      capabilities: ["tool_call", "reasoning"],
      modalities: ["image"],
    });
  });

  it("fails closed on unknown capability values", () => {
    const parsed = parseListingsQuery(params("?capability=__bogus__"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "capability");
    strictEqual(parsed.value, "__bogus__");
    deepStrictEqual(parsed.valid, [...VALID_CAPABILITIES]);
  });

  it("fails closed on unknown modality values", () => {
    const parsed = parseListingsQuery(params("?modality=bogus"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "modality");
    deepStrictEqual(parsed.valid, [...VALID_MODALITIES]);
  });

  it("fails closed on unknown query param names, naming the valid keys (TOG-6365)", () => {
    const parsed = parseListingsQuery(params("?capabilty=tool_call"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "query");
    strictEqual(parsed.value, "capabilty");
    deepStrictEqual(parsed.valid, [...VALID_LISTINGS_QUERY_PARAMS]);
  });

  it("fails closed when valid filters ride with an unknown param (TOG-6365)", () => {
    const parsed = parseListingsQuery(params("?q=alpha&capability=tool_call&bogus=1"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "query");
    strictEqual(parsed.value, "bogus");
  });

  it("accepts every known key together (TOG-6365)", () => {
    const parsed = parseListingsQuery(
      params("?q=a&capability=tool_call&modality=text&limit=5&offset=1"),
    );
    strictEqual(parsed.ok, true);
    strictEqual(parsed.paging.limit, 5);
    strictEqual(parsed.paging.offset, 1);
  });

  it("pins the q length bound at 200 (TOG-6370)", () => {
    strictEqual(LISTINGS_MAX_QUERY_LENGTH, 200);
  });

  it("accepts q at exactly the bound (TOG-6370)", () => {
    const parsed = parseListingsQuery(params(`?q=${"a".repeat(LISTINGS_MAX_QUERY_LENGTH)}`));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.filters.q.length, LISTINGS_MAX_QUERY_LENGTH);
  });

  it("fails closed on q over the bound, naming the limit (TOG-6370)", () => {
    const parsed = parseListingsQuery(params(`?q=${"a".repeat(LISTINGS_MAX_QUERY_LENGTH + 1)}`));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "q");
    deepStrictEqual(parsed.valid, [`at most ${LISTINGS_MAX_QUERY_LENGTH} characters`]);
  });

  it("truncates the echoed over-long q so the 400 page stays bounded (TOG-6370)", () => {
    const parsed = parseListingsQuery(params(`?q=${"b".repeat(10000)}`));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "q");
    ok(parsed.value.length <= 64, `echoed value bounded, got ${parsed.value.length}`);
  });

  it("fails closed on over-long q even with otherwise-valid filters (TOG-6370)", () => {
    const parsed = parseListingsQuery(
      params(`?q=${"c".repeat(LISTINGS_MAX_QUERY_LENGTH + 1)}&capability=tool_call`),
    );
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "q");
  });
});

describe("applyListingsFilters", () => {
  it("returns every listing in stub order with empty filters", () => {
    const result = applyListingsFilters(STUB_LISTINGS, emptyFilters());
    deepStrictEqual(
      result.map((listing) => listing.modelId),
      STUB_LISTINGS.map((listing) => listing.modelId),
    );
  });

  it("treats blank q as no text filtering", () => {
    for (const q of ["", "   "]) {
      strictEqual(applyListingsFilters(STUB_LISTINGS, { ...emptyFilters(), q }).length, 3);
    }
  });

  it("matches q case-insensitively against name, route, and provider", () => {
    const byName = applyListingsFilters(STUB_LISTINGS, { ...emptyFilters(), q: "ALPHA" });
    strictEqual(byName.length, 1);
    strictEqual(byName[0].modelId, "alpha-chat");
    const byRoute = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      q: "northstar/image",
    });
    strictEqual(byRoute.length, 1);
    strictEqual(byRoute[0].modelId, "image-lite");
    const byProvider = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      q: "synthetic provider",
    });
    strictEqual(byProvider.length, 3);
  });

  it("keeps only listings where every named capability is true", () => {
    const toolCall = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      capabilities: ["tool_call"],
    });
    strictEqual(toolCall.length, 1);
    strictEqual(toolCall[0].modelId, "alpha-chat");
    // unknown-tools has missing capability fields: excluded, never guessed.
    const attachment = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      capabilities: ["attachment"],
    });
    strictEqual(attachment.length, 1);
    strictEqual(attachment[0].modelId, "image-lite");
  });

  it("matches modalities in input or output", () => {
    const image = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      modalities: ["image"],
    });
    strictEqual(image.length, 1);
    strictEqual(image[0].modelId, "image-lite");
    const text = applyListingsFilters(STUB_LISTINGS, {
      ...emptyFilters(),
      modalities: ["text"],
    });
    strictEqual(text.length, 3);
  });

  it("ANDs q x capabilities x modalities and preserves stub order", () => {
    const result = applyListingsFilters(STUB_LISTINGS, {
      q: "northstar",
      capabilities: ["tool_call"],
      modalities: ["text"],
    });
    strictEqual(result.length, 1);
    strictEqual(result[0].modelId, "alpha-chat");
    const none = applyListingsFilters(STUB_LISTINGS, {
      q: "zzz-no-such-listing",
      capabilities: [],
      modalities: [],
    });
    strictEqual(none.length, 0);
  });
});

describe("filter-bar rendering", () => {
  it("renders a GET filter form with q, capability, and modality controls", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(html.includes('<form method="get" action="/listings"'));
    ok(html.includes('name="q"'));
    ok(html.includes('name="capability"'));
    ok(html.includes('name="modality"'));
    ok(html.includes('href="/listings"'));
    // XSS rule: reflected q is escaped.
    const evil = renderListingIndex(STUB_LISTINGS, undefined, {
      ...emptyFilters(),
      q: `"><script>alert(1)</script>`,
    });
    ok(!evil.includes("<script>alert(1)</script>"));
    ok(evil.includes("&quot;&gt;&lt;script&gt;"));
  });

  it("renders the empty state with a clear link when nothing matches", () => {
    const html = renderListingIndex([], undefined, emptyFilters());
    ok(html.includes("No listings match these filters."));
    ok(html.includes('href="/listings"'));
    ok(!html.includes("<ul>"));
  });

  it("caps the q input with maxlength matching the server bound (TOG-6370)", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(
      html.includes(`name="q" value="" maxlength="${LISTINGS_MAX_QUERY_LENGTH}"`) ||
        html.includes(`maxlength="${LISTINGS_MAX_QUERY_LENGTH}"`),
      "q input carries the server bound as a client-side hint",
    );
  });

  it("renders the invalid-filter page naming the valid values", () => {
    const html = renderInvalidFilter({
      kind: "capability",
      value: "__bogus__",
      valid: VALID_CAPABILITIES,
    });
    ok(html.includes("<h1>Invalid filter</h1>"));
    ok(html.includes("tool_call"));
    ok(!html.includes("__bogus__") || html.includes("&quot;__bogus__&quot;"));
  });
});
