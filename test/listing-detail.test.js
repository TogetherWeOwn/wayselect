// Tests for the TOG-4882 listing-detail slice: preview flag, stub data,
// renderer, and server routes (node:test, zero dependencies).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isPreviewEnabled } from "../web/preview.js";
import { getStubListing, STUB_LISTINGS } from "../web/stub-listing.js";
import {
  renderListingDetail,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

describe("preview flag", () => {
  it("is off by default and on for truthy values", () => {
    strictEqual(isPreviewEnabled({}), false);
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: "0" }), false);
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: "false" }), false);
    for (const value of ["1", "true", "TRUE", " on "]) {
      strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: value }), true, value);
    }
  });
});

describe("stub listings", () => {
  it("exposes frozen stub data with catalog-entry v1 fields", () => {
    ok(STUB_LISTINGS.length >= 1);
    for (const listing of STUB_LISTINGS) {
      strictEqual(listing.schemaVersion, "v1");
      ok(listing.providerId.length > 0);
      ok(listing.modelId.length > 0);
      ok(listing.entry.name.length > 0);
      ok(Object.isFrozen(listing));
    }
  });

  it("looks up listings by provider/model and returns null for misses", () => {
    const found = getStubListing("northstar", "alpha-chat");
    ok(found);
    strictEqual(found.entry.name, "Alpha Chat");
    strictEqual(getStubListing("northstar", "nope"), null);
  });
});

describe("listing-detail renderer", () => {
  it("renders title, fields, and disabled purchase CTA stub", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    ok(html.includes("<h1>Alpha Chat</h1>"));
    ok(html.includes("northstar/alpha-chat"));
    ok(html.includes("Tool calls"));
    ok(html.includes("Input (per 1M tokens)"));
    ok(html.includes("Purchase (stub"));
    ok(html.includes("disabled"));
    // No live purchase target: the only form posts to the stub route.
    ok(html.includes("/purchase"));
  });

  it("escapes untrusted values in detail, index, and not-found pages", () => {
    const evil = getStubListing("northstar", "alpha-chat");
    const withEvil = {
      ...evil,
      providerId: 'a"><script>alert(1)</script>',
      modelId: "m",
      entry: { ...evil.entry, name: "<b>evil</b>" },
    };
    const html = renderListingDetail(withEvil);
    ok(!html.includes("<script>alert(1)</script>"));
    ok(html.includes("&lt;b&gt;evil&lt;/b&gt;"));
    ok(!renderNotFound("<img src=x>", "y").includes("<img src=x>"));
    ok(!renderListingIndex([withEvil]).includes("<b>evil</b>"));
    ok(renderPreviewDisabled().includes("WAYSELECT_PREVIEW"));
  });
});

describe("preview server routes", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    return `http://localhost:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves the detail page on preview with stub data", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("Alpha Chat"));
    const index = await fetch(`${base}/listings`);
    strictEqual(index.status, 200);
    const missing = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(missing.status, 404);
  });

  it("hides gated routes when the flag is off", async () => {
    const base = await start({});
    strictEqual((await fetch(`${base}/listings`)).status, 404);
    strictEqual((await fetch(`${base}/listings/northstar/alpha-chat`)).status, 404);
  });

  it("refuses the purchase stub with 403 and performs no writes", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
      method: "POST",
    });
    strictEqual(res.status, 403);
    deepStrictEqual(await res.json(), {
      error: "preview_only",
      message: "Purchases are disabled in preview. No backend writes.",
    });
    const get = await fetch(`${base}/listings/northstar/alpha-chat/purchase`);
    strictEqual(get.status, 405);
  });
});

describe("malformed percent-encoding on detail route", () => {
  it("returns 404 instead of crashing the server", async () => {
    const { createApp: newApp } = await import("../web/server.js");
    const server = newApp({ WAYSELECT_PREVIEW: "1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const before = await fetch(`${base}/listings`);
      strictEqual(before.status, 200);
      const malformed = await fetch(`${base}/listings/%E0%A4%A/broken`);
      strictEqual(malformed.status, 404);
      // Server survives: a follow-up request still works.
      const after = await fetch(`${base}/listings`);
      strictEqual(after.status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
