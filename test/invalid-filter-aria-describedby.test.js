// Tests for TOG-8615: filter validation errors reference their inputs via
// aria-describedby (node:test, zero dependencies).
//
// The 400 invalid-filter page renders the correction filter form alongside
// the error summary. Every error entry carries a stable `id`, and the
// control for its kind carries a matching `aria-describedby` (plus
// `aria-invalid` on single-value inputs) so screen-reader users hear the
// error when they land on the field to fix it:
//   - q/limit/offset/sort errors -> the matching input/select
//   - capability/modality errors -> the matching fieldset group (the bad
//     value matches no single checkbox)
//   - unknown-key (`query`) errors -> the form itself (no input exists)
// The suite resolves each referenced id against the rendered page and
// asserts the target element carries the expected error copy.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseListingsQuery } from "../web/filter.js";
import { renderInvalidFilter } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

function params(query) {
  return new URL(`http://localhost/listings${query}`).searchParams;
}

// Every id named by an aria-describedby on the page must exist.
function assertReferencesResolve(html) {
  for (const match of html.matchAll(/aria-describedby="([^"]*)"/g)) {
    for (const id of match[1].split(/\s+/)) {
      ok(html.includes(`id="${id}"`), `describedby target exists: ${id}`);
    }
  }
}

function describedBy(html, controlId) {
  const tag = html.match(new RegExp(`<[^>]*\\bid="${controlId}"[^>]*>`))?.[0];
  ok(tag, `control rendered: ${controlId}`);
  return tag.match(/aria-describedby="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
}

describe("filter errors reference their inputs (TOG-8615)", () => {
  it("links a single limit error to the limit input", () => {
    const html = renderInvalidFilter(
      parseListingsQuery(params("?limit=101")),
    );
    assertReferencesResolve(html);
    const refs = describedBy(html, "filter-limit");
    strictEqual(refs.length, 1, "limit input references one error");
    ok(html.includes(`<p id="${refs[0]}">`), "error element carries the id");
    ok(html.includes("101"), "error names the bad value");
    ok(html.includes('id="filter-limit"'), "input keeps its identity");
  });

  it("links the q error to the search input with aria-invalid", () => {
    const html = renderInvalidFilter(
      parseListingsQuery(params(`?q=${"a".repeat(201)}`)),
    );
    assertReferencesResolve(html);
    const refs = describedBy(html, "filter-q");
    strictEqual(refs.length, 1, "q input references one error");
    const errorBody = new RegExp(`<(?:p|li) id="${refs[0]}">(.*?)</(?:p|li)>`, "s").exec(html)?.[1];
    ok(errorBody?.includes("at most 200 characters"), "error names the bound");
    ok(html.match(/<[^>]*\bid="filter-q"[^>]*aria-invalid="true"/), "q input marked invalid");
  });

  it("links facet errors to their fieldset groups", () => {
    const html = renderInvalidFilter(
      parseListingsQuery(params("?capability=__bad__&modality=nope")),
    );
    assertReferencesResolve(html);
    const capRefs = describedBy(html, "filter-capabilities");
    const modRefs = describedBy(html, "filter-modalities");
    strictEqual(capRefs.length, 1, "capabilities group references one error");
    strictEqual(modRefs.length, 1, "modalities group references one error");
    ok(html.includes("__bad__"), "capability error names the bad value");
    ok(html.includes("nope"), "modality error names the bad value");
  });

  it("links an unknown-key error to the form itself", () => {
    const html = renderInvalidFilter(
      parseListingsQuery(params("?bogus=1")),
    );
    assertReferencesResolve(html);
    const formTag = html.match(/<form\b[^>]*>/)?.[0];
    ok(formTag, "correction form rendered");
    const refs = formTag.match(/aria-describedby="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    strictEqual(refs.length, 1, "form references one error");
    ok(html.includes("bogus"), "error names the bad key");
  });

  it("links every entry of a multi-error page to its control", () => {
    const html = renderInvalidFilter(
      parseListingsQuery(
        params("?bogus=1&capability=__bad__&modality=nope&limit=101&offset=-1"),
      ),
    );
    assertReferencesResolve(html);
    ok(html.includes("5 invalid filters:"), "count announced");
    strictEqual(describedBy(html, "filter-limit").length, 1);
    strictEqual(describedBy(html, "filter-offset").length, 1);
    strictEqual(describedBy(html, "filter-capabilities").length, 1);
    strictEqual(describedBy(html, "filter-modalities").length, 1);
    const formRefs =
      html.match(/<form\b[^>]*>/)?.[0].match(/aria-describedby="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
    strictEqual(formRefs.length, 1, "unknown-key error on the form");
  });

  it("emits no references on the valid index path", async () => {
    const { renderListingIndex } = await import("../web/listing-detail.js");
    const { emptyFilters } = await import("../web/filter.js");
    const { STUB_LISTINGS } = await import("../web/stub-listing.js");
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(!html.includes("aria-describedby"), "no dangling references without errors");
    ok(!html.includes("aria-invalid"), "no invalid flags without errors");
    ok(!html.includes("filter-error-"), "no error ids without errors");
  });

  it("escapes hostile error values inside ids and references", () => {
    const html = renderInvalidFilter({
      kind: "query",
      value: "q",
      valid: ["q"],
      errors: [
        { kind: '<script>alert(1)</script>', value: '"><img src=x>', valid: ["q"] },
        { kind: "capability", value: "__bad__", valid: ["tool_call"] },
      ],
    });
    ok(!html.includes("<script>alert(1)</script>"), "kind escaped");
    assertReferencesResolve(html);
  });
});

describe("invalid-filter association server route (TOG-8615)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the 400 page with the error id matching the input reference", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?limit=101`);
    strictEqual(res.status, 400);
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    assertReferencesResolve(html);
    const refs = describedBy(html, "filter-limit");
    strictEqual(refs.length, 1);
    ok(html.includes(`<p id="${refs[0]}">`), "served error element carries the id");
  });
});
