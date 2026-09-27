// Tests for TOG-6721 (round-4 gap R4-15): over-offset page contract
// (test-only).
//
// `paginateListings` documents that an `offset` past the end yields an empty
// page, never a 400 — but the suite only pinned the boundary case
// (`offset == total`, pure-function level in `listing-pagination.test.js`),
// and the served route never asserted the intact total. These tests pin the
// far-over-offset contract at both levels: empty page + intact total echoed,
// and over HTTP a 200 (never the invalid-filter 400) carrying the full match
// count alongside the empty-page copy.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { paginateListings } from "../web/filter.js";
import { createApp } from "../web/server.js";

// Synthetic catalog in a fixed order.
function bigCatalog(n) {
  return Array.from({ length: n }, (_, i) => ({
    providerId: "synth",
    providerName: "Synthetic",
    modelId: `model-${String(i).padStart(3, "0")}`,
    entry: { name: `Model ${i}` },
  }));
}

function liCount(html) {
  return (html.match(/<li>/g) ?? []).length;
}

describe("over-offset page contract (TOG-6721)", () => {
  it("returns an empty page with the total intact for far-over-offset windows", () => {
    const { page, total, limit, offset } = paginateListings(bigCatalog(10), {
      limit: 5,
      offset: 1000,
    });
    deepStrictEqual(page, []);
    strictEqual(total, 10);
    strictEqual(limit, 5);
    strictEqual(offset, 1000);
  });

  it("keeps the total on over-offset windows of a filtered subset", () => {
    const filtered = bigCatalog(30).slice(0, 7);
    const { page, total } = paginateListings(filtered, { limit: 5, offset: 50 });
    deepStrictEqual(page, []);
    strictEqual(total, 7);
  });
});

describe("over-offset server route (TOG-6721)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("answers 200 (never 400) with the intact total on offset past the end", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?limit=5&offset=1000`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 0);
    ok(
      html.includes("3 listings found. No listings on this page."),
      "intact total + empty-page copy",
    );
    ok(html.includes("Back to first page"), "recovery link");
    ok(!html.includes("<h1>Invalid filter</h1>"), "never the 400 page");
    ok(!html.includes("No listings match these filters."), "not blamed on filters");
  });

  it("keeps the filtered total on over-offset filtered requests", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // q=alpha matches 1 of 3 stubs; offset=50 overshoots it.
    const res = await fetch(`${base}/listings?q=alpha&limit=5&offset=50`);
    strictEqual(res.status, 200);
    const html = await res.text();
    strictEqual(liCount(html), 0);
    ok(
      html.includes("1 listing found. No listings on this page."),
      "singular filtered total kept",
    );
  });
});
