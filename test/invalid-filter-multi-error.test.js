// Tests for TOG-6374 (Gap A4): the HTML 400 page presents every error,
// not just the first (node:test, zero dependencies).
//
// Pins the collect-all contract end to end:
//   - parseListingsQuery collects every problem into `errors` while the
//     top-level kind/value/valid still mirror the first (backward compat)
//   - renderInvalidFilter renders one error as the legacy paragraph
//     (byte-identical copy) and several as a list naming every bad value
//   - GET /listings with multiple bad params returns 400 HTML listing them

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  VALID_CAPABILITIES,
  VALID_LISTINGS_QUERY_PARAMS,
  VALID_MODALITIES,
  parseListingsQuery,
} from "../web/filter.js";
import { renderInvalidFilter } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

describe("parseListingsQuery collects every error (TOG-6374)", () => {
  it("returns a one-entry errors array for a single bad value", () => {
    const parsed = parseListingsQuery(params("?capability=__bogus__"));
    strictEqual(parsed.ok, false);
    strictEqual(parsed.errors.length, 1);
    deepStrictEqual(parsed.errors[0], {
      kind: "capability",
      value: "__bogus__",
      valid: [...VALID_CAPABILITIES],
    });
    // Backward compat: top-level mirrors the first error.
    strictEqual(parsed.kind, "capability");
    strictEqual(parsed.value, "__bogus__");
    deepStrictEqual(parsed.valid, [...VALID_CAPABILITIES]);
  });

  it("collects an unknown key plus bad capability, modality, and paging", () => {
    const parsed = parseListingsQuery(
      params("?bogus=1&capability=__bad__&modality=nope&limit=101&offset=-1"),
    );
    strictEqual(parsed.ok, false);
    strictEqual(parsed.errors.length, 5);
    deepStrictEqual(
      parsed.errors.map((entry) => entry.kind),
      ["query", "capability", "modality", "limit", "offset"],
    );
    strictEqual(parsed.errors[0].value, "bogus");
    deepStrictEqual(parsed.errors[0].valid, [...VALID_LISTINGS_QUERY_PARAMS]);
    strictEqual(parsed.errors[1].value, "__bad__");
    deepStrictEqual(parsed.errors[1].valid, [...VALID_CAPABILITIES]);
    strictEqual(parsed.errors[2].value, "nope");
    deepStrictEqual(parsed.errors[2].valid, [...VALID_MODALITIES]);
    // First error still mirrored on top.
    strictEqual(parsed.kind, "query");
    strictEqual(parsed.value, "bogus");
  });

  it("keeps the ok path unchanged", () => {
    const parsed = parseListingsQuery(params("?q=a&capability=tool_call&limit=5"));
    strictEqual(parsed.ok, true);
    strictEqual(parsed.errors, undefined);
  });
});

describe("renderInvalidFilter lists every error (TOG-6374)", () => {
  it("keeps the legacy paragraph for a single error", () => {
    const html = renderInvalidFilter({
      kind: "capability",
      value: "__bogus__",
      valid: VALID_CAPABILITIES,
    });
    ok(html.includes("<h1>Invalid filter</h1>"), "heading");
    ok(
      html.includes(
        "Unknown capability &quot;__bogus__&quot;. Valid values: attachment, reasoning, tool_call, structured_output.",
      ),
      "legacy single-error copy intact",
    );
    ok(!html.includes("<ul>"), "no list for one error");
    ok(html.includes("Back to listings"), "back link kept");
  });

  it("lists every error when several are present", () => {
    const parsed = parseListingsQuery(
      params("?bogus=1&capability=__bad__&modality=nope&limit=101&offset=-1"),
    );
    const html = renderInvalidFilter(parsed);
    ok(html.includes("<h1>Invalid filter</h1>"), "heading");
    ok(html.includes("5 invalid filters:"), "count announced");
    for (const bad of ["bogus", "__bad__", "nope", "101", "-1"]) {
      ok(html.includes(bad), `bad value named: ${bad}`);
    }
    ok(html.includes("tool_call"), "capability values named");
    ok(html.includes("image"), "modality values named");
    ok(html.includes("capability"), "query valid keys named");
    ok(html.includes("<ul>"), "errors listed");
    ok(html.includes('href="/listings"'), "back link kept");
  });

  it("escapes every untrusted error value", () => {
    const html = renderInvalidFilter({
      kind: "query",
      value: "q",
      valid: VALID_LISTINGS_QUERY_PARAMS,
      errors: [
        { kind: "<script>alert(1)</script>", value: '"><img src=x>', valid: VALID_CAPABILITIES },
        { kind: "query", value: "<b>evil</b>", valid: VALID_LISTINGS_QUERY_PARAMS },
      ],
    });
    ok(!html.includes("<script>alert(1)</script>"), "kind escaped");
    ok(!html.includes('"><img src=x>'), "value escaped");
    ok(!html.includes("<b>evil</b>"), "second value escaped");
    ok(html.includes("<title>Invalid filter — Wayselect</title>"), "title intact");
  });
});

describe("multi-error 400 server route (TOG-6374)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("returns 400 HTML naming every bad param", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(
      `${base}/listings?capability=__bad__&modality=nope&limit=101`,
    );
    strictEqual(res.status, 400);
    ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(html.includes("3 invalid filters:"), "count announced");
    for (const bad of ["__bad__", "nope", "101"]) {
      ok(html.includes(bad), `bad value named: ${bad}`);
    }
    ok(html.includes('href="/listings"'), "back link");
  });

  it("keeps the single-error paragraph on the server path", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?capability=__bogus__`);
    strictEqual(res.status, 400);
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(!html.includes("invalid filters:"), "no count for one error");
    ok(!html.includes("<ul>"), "no list for one error");
  });
});
