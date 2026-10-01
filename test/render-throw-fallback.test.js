// 500 render-throw fallback (TOG-6377, gap B4 from TOG-6346).
//
// web/server.js renders the detail shell and the JSON fragment inside
// try/catch: on a render throw the route answers 500 with the
// `renderListingDetailError` HTML page. Both fallbacks mint a nonce CSP,
// but no test ever triggered them — a regression could silently drop the
// nonce (CSP bypass on the error page) or change the status/content-type
// and no test would fail. This file pins the contract:
//
//   - status 500 with the HTML content-type (even for the JSON-negotiated
//     fragment request — the error path degrades to an HTML page);
//   - `X-Content-Type-Options: nosniff` plus framing denial
//     (`X-Frame-Options: DENY`, `frame-ancestors 'none'`);
//   - a per-response nonce CSP (`style-src`/`script-src` allowlist exactly
//     the response nonce, no `'unsafe-inline'`), and the inline `<style>`
//     tag carries the header nonce;
//   - the error copy (`Listing unavailable`); the error page carries no
//     inline `<script>`, so only the style nonce is pinned;
//   - fresh nonce per 500 response (a leaked error page authorizes nothing
//     else);
//   - control: without the induced throw both routes answer 200, proving
//     the mock (not a broken route) triggers the 500.
//
// Throw induction: `globalThis.encodeURIComponent` is mocked to throw via
// `t.mock.method` (auto-restored after each test). The shell renderer
// builds its fetch path with it and the fragment body builds the purchase
// form action with it, so both render paths throw while the 500 error page
// itself (escape-only, no encoding) still renders. `JSON.stringify` is
// deliberately NOT mocked: undici serializes through it, so that mock
// poisons the fetch client.
//
// node:test, zero dependencies.

import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const HTML_CT = "text/html; charset=utf-8";
const NOSNIFF = "nosniff";

// Same nonce-CSP shape as test/security-headers.test.js (TOG-6049): the
// header carries one base64 nonce shared by style-src and script-src, and
// 'unsafe-inline' appears nowhere.
const NONCE_RE = /'nonce-([A-Za-z0-9+/=]+)'/;
function nonceOfCsp(csp) {
  ok(typeof csp === "string" && csp.length > 0, "CSP header present");
  ok(!csp.includes("'unsafe-inline'"), "no unsafe-inline in CSP");
  const style = csp.match(new RegExp(`style-src 'self' ${NONCE_RE.source}`));
  const script = csp.match(new RegExp(`script-src 'self' ${NONCE_RE.source}`));
  ok(style, `style-src carries a nonce: ${csp}`);
  ok(script, `script-src carries a nonce: ${csp}`);
  strictEqual(style[1], script[1], "style/script share one response nonce");
  return style[1];
}

describe("500 render-throw fallback (TOG-6377)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  // Induce a render throw in both the shell and the fragment renderers
  // (see the header comment for why encodeURIComponent and not stringify).
  function throwOnEncode(t) {
    t.mock.method(globalThis, "encodeURIComponent", () => {
      throw new Error("render-throw probe");
    });
  }

  function pinErrorPage(res, body) {
    strictEqual(res.status, 500);
    strictEqual(res.headers.get("content-type"), HTML_CT);
    strictEqual(res.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(res.headers.get("x-frame-options"), "DENY");
    const nonce = nonceOfCsp(res.headers.get("content-security-policy"));
    ok(body.includes(`<style nonce="${nonce}">`), "style tag carries the header nonce");
    ok(body.includes("Listing unavailable"), "error page title");
    ok(body.includes("role=\"alert\""), "error page is an alert");
    ok(!body.includes("<script"), "error page carries no inline script");
    return nonce;
  }

  it("shell render throw answers 500 HTML with a matching nonce CSP", async (t) => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    throwOnEncode(t);
    const first = await fetch(`${base}/listings/northstar/alpha-chat`);
    const nonce = pinErrorPage(first, await first.text());
    // Fresh nonce per 500 response.
    const second = await fetch(`${base}/listings/northstar/alpha-chat`);
    const nonce2 = pinErrorPage(second, await second.text());
    notStrictEqual(nonce2, nonce, "nonces differ across 500 responses");
  });

  it("fragment render throw answers 500 HTML (not JSON) with a matching nonce CSP", async (t) => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    throwOnEncode(t);
    const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    // The fragment error path degrades to the HTML error page — the shell
    // shows its alert panel instead of choking on a JSON parse.
    pinErrorPage(res, await res.text());
  });

  it("control: both routes answer 200 without the induced throw", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const shell = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(shell.status, 200);
    await shell.text();
    const frag = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    strictEqual(frag.status, 200);
    ok((await frag.json()).html.includes("<h1>Alpha Chat</h1>"), "fragment content");
  });
});
