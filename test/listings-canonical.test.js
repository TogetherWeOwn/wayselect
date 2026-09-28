// TOG-6044: trailing-slash canonical pin for listing routes.
//
// Gap: `/listings` vs `/listings/` (and detail `.../alpha-chat` vs
// `.../alpha-chat/`) both serve 200 with identical bodies — canonicalization
// unpinned (SEO/duplicate-cache risk). Pinned behavior: both variants keep
// serving 200 with identical bodies, and every successful listing page
// carries `<link rel="canonical">` pointing at the slashless path. No
// redirects anywhere (host-header audit pins no-redirect + no Location).
//
// node:test, zero dependencies, stub fixtures only.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetail, renderListingDetailShell, renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

describe("trailing-slash canonical (TOG-6044)", () => {
  // TOG-6049: every HTML response mints a fresh CSP nonce, so two responses
  // never compare byte-identical. Normalize nonces before comparing bodies.
  const stripNonces = (html) => html.replaceAll(/ nonce="[^"]*"/g, "");
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("index: both variants 200 with identical bodies pinned to /listings", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const bare = await fetch(`${base}/listings`);
    const slashed = await fetch(`${base}/listings/`);
    strictEqual(bare.status, 200, "GET /listings");
    strictEqual(slashed.status, 200, "GET /listings/");
    const bareHtml = await bare.text();
    const slashedHtml = await slashed.text();
    strictEqual(
      stripNonces(slashedHtml),
      stripNonces(bareHtml),
      "variants serve identical bodies",
    );
    ok(
      bareHtml.includes('<link rel="canonical" href="/listings">'),
      "index canonical is the slashless path",
    );
  });

  it("detail: both variants 200 with identical bodies pinned to the slashless path", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const path = "/listings/northstar/alpha-chat";
    const bare = await fetch(`${base}${path}`);
    const slashed = await fetch(`${base}${path}/`);
    strictEqual(bare.status, 200, `GET ${path}`);
    strictEqual(slashed.status, 200, `GET ${path}/`);
    const bareHtml = await bare.text();
    const slashedHtml = await slashed.text();
    strictEqual(
      stripNonces(slashedHtml),
      stripNonces(bareHtml),
      "variants serve identical bodies",
    );
    ok(
      bareHtml.includes(`<link rel="canonical" href="${path}">`),
      "detail canonical is the slashless path",
    );
  });

  it("renderers pin the canonical without a server", () => {
    const listing = getStubListing("northstar", "alpha-chat");
    const path = "/listings/northstar/alpha-chat";
    ok(
      renderListingIndex([], undefined, undefined).includes('<link rel="canonical" href="/listings">'),
      "index renderer canonical",
    );
    ok(
      renderListingDetailShell(listing).includes(`<link rel="canonical" href="${path}">`),
      "shell renderer canonical",
    );
    ok(
      renderListingDetail(listing).includes(`<link rel="canonical" href="${path}">`),
      "legacy full renderer canonical",
    );
  });

  it("canonical href escapes reserved characters in route segments", () => {
    const listing = getStubListing("northstar", "alpha-chat");
    const evil = { ...listing, providerId: 'a"><script>alert(1)</script>', modelId: "m" };
    const html = renderListingDetailShell(evil);
    ok(!html.includes("<script>alert(1)</script>"), "no raw script in canonical");
    ok(
      html.includes('<link rel="canonical" href="/listings/a%22%3E%3Cscript%3E'),
      "canonical is percent-encoded",
    );
  });

  it("no redirect, no Location header on either variant", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of ["/listings", "/listings/", "/listings/northstar/alpha-chat"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      ok(res.status < 300 || res.status > 399, `${path} must not redirect`);
      strictEqual(res.headers.get("location"), null, `${path}: no Location header`);
    }
  });
});
