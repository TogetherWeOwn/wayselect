// Tests for TOG-5720: empty-state and error-state rendering on the listing
// index and detail pages (node:test, zero dependencies).
//
// Pins the server contract (status codes, content types) and the renderer
// contract (copy, back links, full page chrome, escaping) for:
//   - index empty state: filters match nothing -> 200, "No listings match
//     these filters." plus a Clear filters link (acceptance S8/E6)
//   - index invalid filter: unknown capability/modality -> 400 naming the
//     valid values, fail closed (acceptance S9/E7)
//   - detail error states: unknown listing -> 404 not-found page; preview
//     flag off -> 404 preview-disabled page (acceptance E1/E5)

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { VALID_CAPABILITIES, VALID_MODALITIES, emptyFilters } from "../web/filter.js";
import {
  renderInvalidFilter,
  renderListingDetailError,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

describe("empty-state rendering (index)", () => {
  it("renders the empty copy with a clear link and no result list", () => {
    const html = renderListingIndex([], undefined, emptyFilters());
    ok(html.includes("No listings match these filters."), "empty copy");
    // TOG-6393: the clear link lands back on the focus target.
    ok(html.includes('href="/listings#results"'), "clear link");
    ok(html.includes("Clear filters"), "clear link label");
    ok(!html.includes("<ul>"), "no result list");
    ok(html.includes('role="status"'), "empty state announced");
    ok(
      html.includes('<section aria-label="Results" id="results" tabindex="-1">'),
      "results focus target kept",
    );
  });

  it("keeps the filter form with the active filters reflected", () => {
    const html = renderListingIndex(
      [],
      undefined,
      { q: "zzz-no-such-listing", capabilities: ["tool_call"], modalities: [] },
    );
    // TOG-6393: the form action pins the results fragment.
    ok(html.includes('<form method="get" action="/listings#results"'), "filter form kept");
    ok(html.includes('value="zzz-no-such-listing"'), "active q reflected");
    ok(html.includes('value="tool_call" checked'), "active capability checked");
  });

  it("escapes the reflected q in the empty state", () => {
    const html = renderListingIndex(
      [],
      undefined,
      { ...emptyFilters(), q: `"><script>alert(1)</script>` },
    );
    ok(!html.includes("<script>alert(1)</script>"), "no raw script");
    ok(html.includes("&quot;&gt;&lt;script&gt;"), "escaped q in form value");
  });

  it("keeps the full page chrome on the empty state", () => {
    const html = renderListingIndex([], undefined, emptyFilters());
    ok(html.includes("<title>Listings — Wayselect</title>"), "title");
    ok(html.includes('class="skip-link"'), "skip link");
    ok(html.includes("<header"), "header landmark");
    ok(html.includes('id="main-content"'), "main target");
    ok(html.includes("<footer"), "footer landmark");
    ok(html.includes("Preview build: stub data only."), "preview banner");
  });
});

describe("invalid-filter rendering (index)", () => {
  it("names the bad capability value and every valid value", () => {
    const html = renderInvalidFilter({
      kind: "capability",
      value: "__bogus__",
      valid: VALID_CAPABILITIES,
    });
    ok(html.includes("<h1>Invalid filter</h1>"), "heading");
    ok(html.includes("__bogus__"), "bad value named");
    for (const name of VALID_CAPABILITIES) {
      ok(html.includes(name), `valid value named: ${name}`);
    }
    ok(html.includes('href="/listings"'), "back link");
    ok(html.includes("Back to listings"), "back link label");
  });

  it("names the bad modality value and every valid value", () => {
    const html = renderInvalidFilter({
      kind: "modality",
      value: "bogus",
      valid: VALID_MODALITIES,
    });
    ok(html.includes("<h1>Invalid filter</h1>"), "heading");
    ok(html.includes("modality"), "kind named");
    ok(html.includes("bogus"), "bad value named");
    for (const name of VALID_MODALITIES) {
      ok(html.includes(name), `valid value named: ${name}`);
    }
  });

  it("escapes untrusted kind and value", () => {
    const html = renderInvalidFilter({
      kind: '<script>alert("k")</script>',
      value: '"><img src=x>',
      valid: VALID_CAPABILITIES,
    });
    ok(!html.includes('<script>alert("k")</script>'), "kind escaped");
    ok(!html.includes('"><img src=x>'), "value escaped");
    ok(html.includes("<title>Invalid filter — Wayselect</title>"), "title intact");
  });

  it("keeps the full page chrome on the invalid-filter page", () => {
    const html = renderInvalidFilter({
      kind: "capability",
      value: "__bogus__",
      valid: VALID_CAPABILITIES,
    });
    ok(html.includes('class="skip-link"'), "skip link");
    ok(html.includes("<header"), "header landmark");
    ok(html.includes('id="main-content"'), "main target");
    ok(html.includes("<footer"), "footer landmark");
  });
});

describe("detail error-page rendering", () => {
  it("renders the not-found page with escaped route and back link", () => {
    const html = renderNotFound("northstar", "nope");
    ok(html.includes("<h1>Listing not found</h1>"), "heading");
    ok(html.includes("<code>northstar/nope</code>"), "route named");
    ok(html.includes('href="/listings"'), "back link");
    ok(html.includes("Back to listings"), "back link label");
    ok(html.includes("<title>Not found — Wayselect</title>"), "title");
    ok(html.includes('class="skip-link"'), "skip link");
    ok(html.includes("<header"), "header landmark");
    ok(html.includes("<footer"), "footer landmark");
  });

  it("renders the detail error page as an alert with escaped ids", () => {
    const html = renderListingDetailError("<img src=x>", "y");
    ok(!html.includes("<img src=x>"), "provider id escaped");
    ok(html.includes('role="alert"'), "alert region");
    ok(html.includes("Couldn"), "error heading copy");
    ok(html.includes('href="/listings"'), "back link");
    ok(html.includes("Preview build: stub data only."), "preview banner");
  });

  it("renders the preview-disabled page naming the flag", () => {
    const html = renderPreviewDisabled();
    ok(html.includes("<h1>Preview unavailable</h1>"), "heading");
    ok(html.includes("WAYSELECT_PREVIEW"), "flag named");
    ok(html.includes("<title>Preview unavailable — Wayselect</title>"), "title");
    ok(html.includes('class="skip-link"'), "skip link");
    ok(html.includes("<header"), "header landmark");
    ok(html.includes("<footer"), "footer landmark");
  });
});

describe("empty-state and error-state server routes (TOG-5720)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("returns 200 HTML with the empty state when filters match nothing", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=zzz-no-such-listing`);
    strictEqual(res.status, 200);
    ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
    const html = await res.text();
    ok(html.includes("No listings match these filters."), "empty copy");
    ok(html.includes("Clear filters"), "clear link");
    ok(html.includes('href="/listings#results"'), "clear target");
    ok(!html.includes("<ul>"), "no result list");
  });

  it("returns 200 with the empty state for a valid-but-empty filter combo", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Alpha Chat has attachment=false, so q=alpha x attachment matches nothing.
    const res = await fetch(`${base}/listings?q=alpha&capability=attachment`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("No listings match these filters."), "empty copy");
    ok(!html.includes("Alpha Chat</h1>"), "no listing rendered");
  });

  it("returns 400 HTML naming valid values for an unknown capability", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?capability=__bogus__`);
    strictEqual(res.status, 400);
    ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(html.includes("__bogus__"), "bad value named");
    ok(html.includes("tool_call"), "valid values named");
    ok(html.includes('href="/listings"'), "back link");
  });

  it("returns 400 HTML naming valid values for an unknown modality", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?modality=bogus`);
    strictEqual(res.status, 400);
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(html.includes("image"), "valid modalities named");
  });

  it("returns 400 HTML naming the bound for an over-long q (TOG-6370)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=${"a".repeat(201)}`);
    strictEqual(res.status, 400);
    ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(html.includes("200"), "bound named");
    ok(html.includes('href="/listings"'), "back link");
  });

  it("accepts q at exactly the bound through the server (TOG-6370)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=${"a".repeat(200)}`);
    strictEqual(res.status, 200);
  });

  it("returns 400 HTML naming valid params for an unknown query key (TOG-6365)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?capabilty=tool_call`);
    strictEqual(res.status, 400);
    ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
    const html = await res.text();
    ok(html.includes("<h1>Invalid filter</h1>"), "error heading");
    ok(html.includes("capabilty"), "bad key named");
    ok(html.includes("capability"), "valid keys named");
    ok(html.includes('href="/listings"'), "back link");
  });

  it("fails closed on mixed valid and invalid filter values", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?capability=tool_call&capability=__bogus__`);
    strictEqual(res.status, 400);
    ok((await res.text()).includes("<h1>Invalid filter</h1>"), "still a 400");
  });

  it("returns the 404 not-found page with a back link for unknown listings", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(res.status, 404);
    const html = await res.text();
    ok(html.includes("Listing not found"), "not-found copy");
    ok(html.includes('href="/listings"'), "back link");
  });

  it("gates filtered index requests behind the preview flag too", async () => {
    const base = await start({});
    const filtered = await fetch(`${base}/listings?q=alpha`);
    strictEqual(filtered.status, 404);
    ok((await filtered.text()).includes("Preview unavailable"), "flag-off page");
    const bogus = await fetch(`${base}/listings?capability=__bogus__`);
    strictEqual(bogus.status, 404);
    ok((await bogus.text()).includes("Preview unavailable"), "flag check precedes filter parse");
  });
});
