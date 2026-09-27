// Tests for TOG-5752: designed HTML 404 page for unknown listings.
//
// The unknown-listing miss stays a 404 with the TOG-5714 HTML content-type
// contract, and the page is on-brand: miss named, a search hint (model id
// prefilled as the index `q`) plus the listing-index link, in the listing
// shell chrome. node:test, zero dependencies.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { LISTINGS_MAX_QUERY_LENGTH } from "../web/filter.js";
import { renderNotFound } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";

describe("unknown-listing 404 design (TOG-5752)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the miss as 404 HTML with the search hint and index link", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(res.status, 404);
    strictEqual(res.headers.get("content-type"), HTML_CT);
    const html = await res.text();
    ok(html.includes("<h1>Listing not found</h1>"), "miss heading");
    ok(html.includes("<code>northstar/nope</code>"), "miss named");
    ok(html.includes('href="/listings?q=nope"'), "search-hint link with model id as q");
    ok(html.includes("searching the listings"), "search-hint copy");
    ok(html.includes('href="/listings"'), "index link");
    ok(html.includes("Back to listings"), "index link label");
  });

  it("keeps the full listing-shell chrome on the miss page", () => {
    const html = renderNotFound("northstar", "nope");
    ok(html.includes("<title>Not found — Wayselect</title>"), "title");
    ok(html.includes('class="skip-link"'), "skip link");
    ok(html.includes("<header"), "header landmark");
    ok(html.includes('id="main-content"'), "main target");
    ok(html.includes("<footer"), "footer landmark");
  });

  it("escapes untrusted ids in the miss line and the hint href", () => {
    const html = renderNotFound("<img src=x>", `"><script>alert(1)</script>`);
    ok(!html.includes("<img src=x>"), "provider id escaped");
    ok(!html.includes("<script>alert(1)</script>"), "model id escaped");
    ok(
      html.includes("/listings?q=%22%3E%3Cscript%3E"),
      "hint query URL-encoded so it cannot break out of the href",
    );
  });

  it("caps the hint query at the index q bound so the link never 400s", () => {
    const longId = "m".repeat(LISTINGS_MAX_QUERY_LENGTH + 50);
    const html = renderNotFound("northstar", longId);
    const match = html.match(/\/listings\?q=([^"]+)/);
    ok(match, "hint link present");
    strictEqual(decodeURIComponent(match[1]).length, LISTINGS_MAX_QUERY_LENGTH);
  });

  it("keeps the JSON fragment contract for unknown listings", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/nope`, {
      headers: { accept: "application/json" },
    });
    strictEqual(res.status, 404);
    strictEqual(res.headers.get("content-type"), "application/json; charset=utf-8");
  });
});
