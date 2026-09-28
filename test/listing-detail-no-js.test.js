// No-JS fallback audit for the listing-detail fragment (TOG-7287).
//
// With JavaScript disabled, `GET /listings/:provider/:model` (flag on)
// renders the full listing inside the shell's `<noscript>` branch —
// byte-identical to the `application/json` fragment payload (`html`),
// both rendered from the same `listingDetailBody` builder. This file pins
// that contract end to end: the noscript branch carries every core listing
// section (N1–N8 in docs/wayselect-no-js-fallback.md), the served plain-GET
// body agrees with the served fragment, and the operator doc stays in sync
// with the implementation so doc drift fails here by design.
//
// node:test, zero dependencies; server tests bind an ephemeral localhost
// port (loopback only, per CONTRIBUTING.md).

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { getStubListing } from "../web/stub-listing.js";
import {
  listingDetailFragment,
  renderListingDetail,
  renderListingDetailShell,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

const DOC = new URL("../docs/wayselect-no-js-fallback.md", import.meta.url);
const README = new URL("../README.md", import.meta.url);
const RENDERER = new URL("../web/listing-detail.js", import.meta.url);

// Core listing content every no-JS response must carry (N1–N8 in the doc).
// Each entry is a substring of the noscript body for the alpha-chat stub.
const CORE_CONTENT = [
  "Preview build: stub data only. No purchase is processed.", // N1 banner
  "<h1>Alpha Chat</h1>", // N2 title
  "northstar/alpha-chat", // N3 route
  "Northstar Synthetic Provider", // N3 provider
  'aria-label="Eligibility"', // N4 eligibility section
  "Attachments", // N5 capabilities
  "Reasoning", // N5
  "Tool calls", // N5
  "Structured output", // N5
  "List-price estimate", // N6 prices
  "Synthetic list-price estimates only", // N6 disclaimer
  'action="/listings/northstar/alpha-chat/purchase"', // N7 stub form
  "disabled", // N7 stub stays disabled
  "Back to listings", // N8 back link
];

// The single `<noscript>` branch: the renderer emits exactly one, lowercase,
// with escaped attrs, so indexOf extraction is sound (TOG-6049/TOG-6028
// CodeQL-safe precedent — no tag-strip replaceAll, no filtering regexp).
function noscriptBody(html) {
  const open = html.indexOf("<noscript>");
  ok(open !== -1, "shell carries a <noscript> branch");
  const close = html.indexOf("</noscript>", open);
  ok(close !== -1, "noscript branch is closed");
  strictEqual(
    html.indexOf("<noscript>", close),
    -1,
    "exactly one noscript branch",
  );
  return html.slice(open + "<noscript>".length, close);
}

// Shell-chrome segments outside the <noscript>/<script> blocks (same
// precedent as test/listing-detail-loading.test.js): pure extraction, no
// tag-stripping replacement.
function chromeSegments(html) {
  const segments = [];
  let cursor = 0;
  while (cursor < html.length) {
    const nosOpen = html.indexOf("<noscript>", cursor);
    const scriptOpen = html.indexOf("<script", cursor);
    let open = -1;
    let tag = null;
    if (nosOpen !== -1 && (scriptOpen === -1 || nosOpen < scriptOpen)) {
      open = nosOpen;
      tag = "noscript";
    } else if (scriptOpen !== -1) {
      open = scriptOpen;
      tag = "script";
    } else {
      segments.push(html.slice(cursor));
      break;
    }
    segments.push(html.slice(cursor, open));
    const closeTag = `</${tag}>`;
    const close = html.indexOf(closeTag, open);
    if (close === -1) {
      break;
    }
    cursor = close + closeTag.length;
  }
  return segments;
}

describe("no-JS fallback body (TOG-7287)", () => {
  it("renders every core listing section inside <noscript>", () => {
    const shell = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    const noscript = noscriptBody(shell);
    for (const expected of CORE_CONTENT) {
      ok(noscript.includes(expected), `noscript carries ${JSON.stringify(expected)}`);
    }
  });

  it("keeps the noscript body byte-identical to the JSON fragment", () => {
    const listing = getStubListing("northstar", "alpha-chat");
    const shell = renderListingDetailShell(listing);
    const fragment = listingDetailFragment(listing);
    strictEqual(
      noscriptBody(shell),
      fragment.html,
      "one builder, two consumers — noscript and fragment can never drift",
    );
    ok(
      renderListingDetail(listing).includes(fragment.html),
      "legacy full render contains the same body",
    );
  });

  it("carries the fail-closed unknown state without JS", () => {
    const shell = renderListingDetailShell(getStubListing("northstar", "unknown-tools"));
    const noscript = noscriptBody(shell);
    ok(noscript.includes("<h1>Unknown Tools</h1>"), "noscript titles the listing");
    ok(noscript.includes("Unknown"), "missing capabilities render Unknown, never Yes");
    ok(noscript.includes("Back to listings"), "back link present");
  });

  it("escapes untrusted values on the no-JS path", () => {
    const evil = getStubListing("northstar", "alpha-chat");
    const withEvil = {
      ...evil,
      providerId: 'a"><script>alert(1)</script>',
      modelId: "m",
      entry: { ...evil.entry, name: "<b>evil</b>" },
    };
    const noscript = noscriptBody(renderListingDetailShell(withEvil));
    ok(!noscript.includes("<script>alert(1)</script>"), "noscript escapes route");
    ok(noscript.includes("&lt;b&gt;evil&lt;/b&gt;"), "noscript escapes name");
  });

  it("keeps the only form inside the no-JS/fragment body, never the shell chrome", () => {
    const shell = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(
      chromeSegments(shell).every((seg) => !seg.includes("<form")),
      "no live form in shell chrome",
    );
    ok(noscriptBody(shell).includes("<form"), "disabled stub form ships with the content");
  });
});

describe("no-JS fallback served routes (TOG-7287)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the core listing content on plain GET (the no-JS response)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(res.status, 200);
    const noscript = noscriptBody(await res.text());
    for (const expected of CORE_CONTENT) {
      ok(noscript.includes(expected), `served no-JS body carries ${JSON.stringify(expected)}`);
    }
  });

  it("serves a noscript body byte-identical to the served fragment", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const shellRes = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(shellRes.status, 200);
    const servedNoscript = noscriptBody(await shellRes.text());
    const fragRes = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    strictEqual(fragRes.status, 200);
    strictEqual(
      servedNoscript,
      (await fragRes.json()).html,
      "served shell and served fragment agree byte for byte",
    );
  });

  it("renders no listing noscript when the preview flag is off", async () => {
    const base = await start({});
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(res.status, 404);
    const body = await res.text();
    ok(body.includes("Preview unavailable"), "flag-off page");
    ok(!body.includes("<h1>Alpha Chat</h1>"), "no listing content leaks flag-off");
  });
});

describe("no-JS fallback doc (TOG-7287)", () => {
  it("pins the implementation the no-JS path runs through", () => {
    const doc = readFileSync(DOC, "utf8");
    for (const symbol of [
      "<noscript>",
      "`renderListingDetailShell`",
      "`listingDetailBody`",
      "`listingDetailFragment`",
      "`web/server.js`",
    ]) {
      ok(doc.includes(symbol), `doc must name ${symbol}`);
    }
    const source = readFileSync(RENDERER, "utf8");
    ok(source.includes("<noscript>"), "renderer still emits the noscript branch");
  });

  it("is linked from the README docs index", () => {
    const readme = readFileSync(README, "utf8");
    ok(
      readme.includes("docs/wayselect-no-js-fallback.md"),
      "README.md docs index must link docs/wayselect-no-js-fallback.md (CONTRIBUTING.md: new docs specs go in the index)",
    );
  });
});
