// Tests for TOG-6732: index page skip-link parity (test-only).
//
// The detail page carries a skip link; this pins the equivalent contract on
// the served `/listings` index page over HTTP: a skip link plus the
// `#main-content` target, byte-identical to the detail page served by the
// same app. Renderer-level coverage exists in `listing-a11y.test.js`; this
// file covers the served route (flag-gated 200 path), which nothing asserted.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const SKIP_ANCHOR = '<a class="skip-link" href="#main-content">Skip to main content</a>';

describe("index skip-link parity (TOG-6732)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves an equivalent skip link + #main-content target on /listings", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes(SKIP_ANCHOR), "index skip link");
    ok(html.includes('id="main-content"'), "index main target");
    // The link precedes the target so keyboard/SR users can jump forward.
    ok(
      html.indexOf(SKIP_ANCHOR) < html.indexOf('id="main-content"'),
      "skip link before main",
    );
  });

  it("matches the detail page skip-link markup exactly", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const [indexHtml, detailHtml] = await Promise.all([
      fetch(`${base}/listings`).then((r) => {
        strictEqual(r.status, 200);
        return r.text();
      }),
      fetch(`${base}/listings/northstar/alpha-chat`).then((r) => {
        strictEqual(r.status, 200);
        return r.text();
      }),
    ]);
    ok(detailHtml.includes(SKIP_ANCHOR), "detail skip link");
    ok(detailHtml.includes('id="main-content"'), "detail main target");
    strictEqual(indexHtml.includes(SKIP_ANCHOR), true, "parity: index carries the same anchor");
  });
});
