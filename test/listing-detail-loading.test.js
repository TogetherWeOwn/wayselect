// Tests for the TOG-5499 listing-detail loading-state slice: skeleton shell
// first paint, JSON fragment content negotiation, slow-network knob, and
// fail-closed error states (node:test, zero dependencies).

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import {
  listingDetailFragment,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

describe("listing-detail shell", () => {
  it("paints the skeleton first with busy state, retry, and noscript content", () => {
    const html = renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
    ok(html.includes('aria-busy="true"'), "busy region");
    ok(html.includes("skeleton-title"), "skeleton blocks");
    ok(html.includes("Loading listing details"), "loading copy");
    ok(html.includes('id="listing-detail-retry"'), "retry control");
    ok(html.includes('role="alert"'), "error alert region");
    // No-JS fallback: the noscript branch carries the full render.
    ok(html.includes("<noscript>"), "noscript branch");
    ok(html.includes("&lt;") || html.includes("Alpha Chat"), "noscript content");
    // No live action in the shell chrome: strip noscript/script blocks and
    // assert no form survives; the only form (disabled purchase stub) lives
    // in the noscript/fragment render.
    const chrome = html
      .replaceAll(/<noscript>[\s\S]*?<\/noscript>/g, "")
      .replaceAll(/<script>[\s\S]*?<\/script>/g, "");
    ok(!chrome.includes("<form"), "no live form in shell chrome");
    ok(html.includes("disabled"), "noscript purchase stub stays disabled");
  });

  it("escapes untrusted values in the shell and error page", () => {
    const evil = getStubListing("northstar", "alpha-chat");
    const withEvil = {
      ...evil,
      providerId: 'a"><script>alert(1)</script>',
      modelId: "m",
      entry: { ...evil.entry, name: "<b>evil</b>" },
    };
    const shell = renderListingDetailShell(withEvil);
    ok(!shell.includes("<script>alert(1)</script>"), "shell escapes route");
    ok(shell.includes("&lt;b&gt;evil&lt;/b&gt;"), "shell escapes name");
    const err = renderListingDetailError("<img src=x>", "y");
    ok(!err.includes("<img src=x>"), "error page escapes values");
    ok(err.includes('role="alert"'), "error page is an alert");
  });

  it("derives the fragment from the same builder as the full render", () => {
    const listing = getStubListing("northstar", "alpha-chat");
    const fragment = listingDetailFragment(listing);
    ok(typeof fragment.html === "string", "fragment payload shape");
    ok(fragment.html.includes("<h1>Alpha Chat</h1>"), "fragment content");
    // Fragment body matches the full render body (no drift between noscript,
    // async content, and the legacy full render).
    ok(renderListingDetail(listing).includes(fragment.html), "fragment equals full body");
  });
});

describe("listing-detail loading server routes", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the shell on plain GET and the fragment on JSON negotiation", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const shell = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(shell.status, 200);
    const shellHtml = await shell.text();
    ok(shellHtml.includes("skeleton-title"), "shell first paint");
    ok(shellHtml.includes("<noscript>"), "noscript fallback");
    const frag = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    strictEqual(frag.status, 200);
    const payload = await frag.json();
    ok(payload.html.includes("<h1>Alpha Chat</h1>"), "fragment content");
  });

  it("returns a JSON error for fragment misses, HTML for plain misses", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fragMiss = await fetch(`${base}/listings/northstar/nope`, {
      headers: { accept: "application/json" },
    });
    strictEqual(fragMiss.status, 404);
    strictEqual((await fragMiss.json()).error, "listing_not_found");
    const htmlMiss = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(htmlMiss.status, 404);
    ok((await htmlMiss.text()).includes("Listing not found"), "HTML miss page");
  });

  it("delays only the fragment under the slow-network knob, never the shell", async () => {
    const base = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: "600",
    });
    const shellStart = Date.now();
    const shell = await fetch(`${base}/listings/northstar/alpha-chat`);
    const shellMs = Date.now() - shellStart;
    strictEqual(shell.status, 200);
    ok(shellMs < 500, `shell stays fast under the knob (took ${shellMs}ms)`);
    const fragStart = Date.now();
    const frag = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    const fragMs = Date.now() - fragStart;
    strictEqual(frag.status, 200);
    ok(fragMs >= 500, `fragment is delayed (took ${fragMs}ms)`);
  });

  it("keeps the shell behind the preview flag", async () => {
    const base = await start({});
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(res.status, 404);
    ok((await res.text()).includes("Preview unavailable"), "flag-off page");
  });
});
