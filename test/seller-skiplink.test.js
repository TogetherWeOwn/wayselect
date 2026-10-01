// Tests for TOG-7274: seller-page skip-link parity (test-only).
//
// The seller layout (web/seller.js) already renders the same skip-link
// anchor + `#main-content` target as the listing pages; nothing asserted it
// on the served `/sellers` routes. This pins that contract over HTTP,
// mirroring the index parity pin in `listing-index-skiplink.test.js`
// (TOG-6732): every HTML seller surface — staged confirm, intent-recorded
// receipt, missing-intent 404, and fail-closed rejection — carries a
// focusable skip link byte-identical to the listing pages.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createApp } from "../web/server.js";

const SKIP_ANCHOR = '<a class="skip-link" href="#main-content">Skip to main content</a>';

describe("seller skip-link parity (TOG-7274)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function readSellerFixtures() {
    return JSON.parse(
      await readFile(
        new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
        "utf8",
      ),
    );
  }

  async function stageIntent(base) {
    const fixtures = await readSellerFixtures();
    const res = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(res.status, 200);
    await res.json();
  }

  function assertSkipLinkFirst(html, label) {
    ok(html.includes(SKIP_ANCHOR), `${label} skip link`);
    ok(html.includes('id="main-content"'), `${label} main target`);
    // The link precedes the target so keyboard/SR users can jump forward,
    // and the target carries tabindex="-1" so focus can move there.
    ok(
      html.indexOf(SKIP_ANCHOR) < html.indexOf('id="main-content"'),
      `${label} skip link before main`,
    );
    ok(
      html.includes('<main id="main-content" tabindex="-1">'),
      `${label} focusable main target`,
    );
  }

  it("serves a focusable skip link on the staged confirm screen", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    await stageIntent(base);
    const res = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { headers: { accept: "text/html" } },
    );
    strictEqual(res.status, 200);
    assertSkipLinkFirst(await res.text(), "confirm");
  });

  it("serves a focusable skip link on the intent-recorded receipt", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    await stageIntent(base);
    const res = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { method: "POST", headers: { accept: "text/html" } },
    );
    strictEqual(res.status, 200);
    assertSkipLinkFirst(await res.text(), "receipt");
  });

  it("serves a focusable skip link on the missing-intent and rejection pages", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const missing = await fetch(
      `${base}/sellers/submissions/northstar/nope/confirm`,
      { headers: { accept: "text/html" } },
    );
    strictEqual(missing.status, 404);
    assertSkipLinkFirst(await missing.text(), "missing-intent");

    const fixtures = await readSellerFixtures();
    const forbidden = structuredClone(fixtures.valid);
    forbidden.entry.url = "https://example.invalid/x";
    const rejected = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify(forbidden),
    });
    strictEqual(rejected.status, 400);
    assertSkipLinkFirst(await rejected.text(), "rejection");
  });

  it("matches the listing index skip-link markup exactly", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    await stageIntent(base);
    const [sellerHtml, indexHtml] = await Promise.all([
      fetch(`${base}/sellers/submissions/northstar/seller-chat/confirm`, {
        headers: { accept: "text/html" },
      }).then((r) => {
        strictEqual(r.status, 200);
        return r.text();
      }),
      fetch(`${base}/listings`).then((r) => {
        strictEqual(r.status, 200);
        return r.text();
      }),
    ]);
    ok(indexHtml.includes(SKIP_ANCHOR), "index skip link");
    strictEqual(sellerHtml.includes(SKIP_ANCHOR), true, "parity: seller carries the same anchor");
  });
});
