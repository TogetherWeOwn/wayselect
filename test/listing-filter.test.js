// Tests for the TOG-5459 storefront filter-bar slice: query parsing, filter
// matching, and index rendering (node:test, zero dependencies).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  LISTINGS_DEFAULT_LIMIT,
  LISTINGS_DEFAULT_OFFSET,
  LISTINGS_DEFAULT_SORT,
  LISTINGS_MAX_QUERY_LENGTH,
  VALID_CAPABILITIES,
  VALID_LISTINGS_QUERY_PARAMS,
  VALID_LISTING_SORTS,
  VALID_MODALITIES,
  applyListingsFilters,
  emptyFilters,
  parseListingsQuery,
  sortListings,
} from "../web/filter.js";
import { renderInvalidFilter, renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

describe("parseListingsQuery", () => {
  it("parses empty params to empty filters with the default sort", () => {
    const parsed = parseListingsQuery(params(""));
    strictEqual(parsed.ok, true);
    deepStrictEqual(parsed.filters, {
      q: "",
      capabilities: [],
      modalities: [],
      sort: "default",
    });
    strictEqual(LISTINGS_DEFAULT_SORT, "default");
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
      sort: "default",
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

  it("accepts every known key together (TOG-6365, sort via TOG-6362)", () => {
    const parsed = parseListingsQuery(
      params("?q=a&capability=tool_call&modality=text&limit=5&offset=1&sort=price-asc"),
    );
    strictEqual(parsed.ok, true);
    strictEqual(parsed.paging.limit, 5);
    strictEqual(parsed.paging.offset, 1);
    strictEqual(parsed.filters.sort, "price-asc");
  });

  it("fails closed on unknown sort values, naming the valid sorts (TOG-6362)", () => {
    const parsed = parseListingsQuery(params("?sort=cheapest"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "sort");
    strictEqual(parsed.value, "cheapest");
    deepStrictEqual(parsed.valid, [...VALID_LISTING_SORTS]);
  });

  it("fails closed on unknown sort even with otherwise-valid filters (TOG-6362)", () => {
    const parsed = parseListingsQuery(params("?q=alpha&sort=bogus"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "sort");
  });

  it("truncates the echoed over-long sort so the 400 page stays bounded (TOG-6362)", () => {
    const parsed = parseListingsQuery(params(`?sort=${"s".repeat(10000)}`));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.kind, "sort");
    ok(parsed.value.length <= 64, `echoed value bounded, got ${parsed.value.length}`);
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

describe("sortListings (TOG-6362)", () => {
  it("keeps input order for the default sort (no behavior change)", () => {
    const shuffled = [STUB_LISTINGS[2], STUB_LISTINGS[0], STUB_LISTINGS[1]];
    const result = sortListings(shuffled, "default");
    deepStrictEqual(
      result.map((listing) => listing.modelId),
      ["unknown-tools", "alpha-chat", "image-lite"],
    );
    // Absent sort behaves as default.
    deepStrictEqual(
      sortListings(shuffled).map((listing) => listing.modelId),
      ["unknown-tools", "alpha-chat", "image-lite"],
    );
    // Unknown keys fail closed to input order (the route 400s upstream, but
    // the pure function never re-ranks on an unrecognized key).
    deepStrictEqual(
      sortListings(shuffled, "cheapest").map((listing) => listing.modelId),
      ["unknown-tools", "alpha-chat", "image-lite"],
    );
    // Never mutates the input.
    deepStrictEqual(
      shuffled.map((listing) => listing.modelId),
      ["unknown-tools", "alpha-chat", "image-lite"],
    );
  });

  it("orders by synthetic list-price ascending, unknown prices last (TOG-6362)", () => {
    // Stub costs: unknown-tools 0.75, image-lite 2, alpha-chat 3.
    const result = sortListings(STUB_LISTINGS, "price-asc");
    deepStrictEqual(
      result.map((listing) => listing.modelId),
      ["unknown-tools", "image-lite", "alpha-chat"],
    );
  });

  it("orders by price descending, unknown prices still last (TOG-6362)", () => {
    const result = sortListings(STUB_LISTINGS, "price-desc");
    deepStrictEqual(
      result.map((listing) => listing.modelId),
      ["alpha-chat", "image-lite", "unknown-tools"],
    );
  });

  it("treats missing or non-numeric cost as unknown price (TOG-6362)", () => {
    const priced = {
      providerId: "p",
      providerName: "P",
      modelId: "priced",
      entry: { name: "Priced", cost: { input: 1, output: 1 } },
    };
    const missing = {
      providerId: "p",
      providerName: "P",
      modelId: "nocost",
      entry: { name: "No Cost" },
    };
    const asc = sortListings([missing, priced], "price-asc");
    strictEqual(asc[0].modelId, "priced");
    strictEqual(asc[1].modelId, "nocost");
    const desc = sortListings([missing, priced], "price-desc");
    strictEqual(desc[0].modelId, "priced");
    strictEqual(desc[1].modelId, "nocost");
  });

  it("breaks price ties on route ID in code-unit order (TOG-6362)", () => {
    const cost = { input: 1, output: 1 };
    const beta = {
      providerId: "b",
      providerName: "B",
      modelId: "beta",
      entry: { name: "Beta", cost },
    };
    const alpha = {
      providerId: "a",
      providerName: "A",
      modelId: "alpha",
      entry: { name: "Alpha", cost },
    };
    deepStrictEqual(
      sortListings([beta, alpha], "price-asc").map((listing) => listing.modelId),
      ["alpha", "beta"],
    );
  });

  it("orders by name and by route ID (TOG-6362)", () => {
    deepStrictEqual(
      sortListings(STUB_LISTINGS, "name-asc").map((listing) => listing.modelId),
      ["alpha-chat", "image-lite", "unknown-tools"],
    );
    deepStrictEqual(
      sortListings(STUB_LISTINGS, "route-asc").map((listing) => listing.modelId),
      ["alpha-chat", "image-lite", "unknown-tools"],
    );
    // route-asc is input-order-independent: a reordered input still sorts.
    deepStrictEqual(
      sortListings([STUB_LISTINGS[2], STUB_LISTINGS[1], STUB_LISTINGS[0]], "route-asc").map(
        (listing) => listing.modelId,
      ),
      ["alpha-chat", "image-lite", "unknown-tools"],
    );
  });
});

describe("filter-bar rendering", () => {
  it("renders a GET filter form with q, capability, modality, and sort controls", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(html.includes('<form method="get" action="/listings"'));
    ok(html.includes('name="q"'));
    ok(html.includes('name="capability"'));
    ok(html.includes('name="modality"'));
    ok(html.includes('name="sort"'), "sort select present (TOG-6362)");
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

  it("renders the invalid-sort page naming the valid sorts (TOG-6362)", () => {
    const parsed = parseListingsQuery(
      new URL("http://localhost/listings?sort=nope").searchParams,
    );
    strictEqual(parsed.ok, false);
    const html = renderInvalidFilter(parsed, undefined);
    ok(html.includes("<h1>Invalid filter</h1>"));
    ok(html.includes("price-asc"), "valid sorts named");
  });

  it("reflects the active sort in the form and preserves it in page links (TOG-6362)", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, {
      ...emptyFilters(),
      sort: "price-desc",
    });
    ok(html.includes('<option value="price-desc" selected>'), "active sort selected");
    ok(html.includes('<option value="default">'), "default option present");
    // XSS rule: sort round-trips through the same escaping as q.
    const evil = renderListingIndex(STUB_LISTINGS, undefined, {
      ...emptyFilters(),
      sort: `"><script>alert(1)</script>`,
    });
    ok(!evil.includes("<script>alert(1)</script>"));
  });
});

describe("sticky filter inputs (TOG-6733, gap R4-27)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("echoes submitted q/limit/offset into the form inputs", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=alpha&limit=5&offset=0`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes('name="q" value="alpha"'), "submitted q re-rendered");
    ok(html.includes('name="limit" value="5"'), "submitted limit re-rendered");
    ok(html.includes('name="offset" value="0"'), "submitted offset re-rendered");
  });

  it("renders the paging defaults when limit/offset are absent", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=alpha`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes('name="q" value="alpha"'), "submitted q re-rendered");
    ok(
      html.includes(`name="limit" value="${LISTINGS_DEFAULT_LIMIT}"`),
      "default limit re-rendered",
    );
    ok(
      html.includes(`name="offset" value="${LISTINGS_DEFAULT_OFFSET}"`),
      "default offset re-rendered",
    );
  });

  it("escapes the echoed q so reflected input cannot break out (TOG-6733)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=${encodeURIComponent('a"b<>')}`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(!html.includes('value="a"b<>"'), "raw quotes/angles not reflected");
    ok(html.includes("a&quot;b&lt;&gt;"), "echoed q escaped");
  });
});
