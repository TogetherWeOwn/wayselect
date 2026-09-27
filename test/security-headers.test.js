// Tests for the TOG-5731 preview security headers with the TOG-6049 nonce CSP.
//
// Contract (documented in web/server.js):
//   - Every response (HTML and JSON, including 429 refusals) carries
//     `X-Content-Type-Options: nosniff`.
//   - HTML responses additionally deny framing (`X-Frame-Options: DENY`
//     plus `frame-ancestors 'none'`) and carry a per-response nonce CSP:
//     `style-src`/`script-src` allowlist exactly the request nonce, no
//     `'unsafe-inline'` anywhere, and the nonce on the inline `<style>`
//     (every page) / `<script>` (detail shell) tags matches the header.
//   - JSON responses carry no framing/CSP headers (nothing to frame).
//
// node:test, zero dependencies.

import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const NOSNIFF = "nosniff";

// TOG-6049: assert the nonce CSP shape. The CSP carries a base64 nonce that
// must match the `nonce="…"` attribute stamped on the inline tags; each
// response mints a fresh value.
const NONCE_RE = /'nonce-([A-Za-z0-9+/=]+)'/;
function nonceOfCsp(csp) {
  ok(typeof csp === "string" && csp.length > 0, "CSP header present");
  ok(!csp.includes("'unsafe-inline'"), "no unsafe-inline in CSP");
  const style = csp.match(new RegExp(`style-src 'self' ${NONCE_RE.source}`));
  const script = csp.match(new RegExp(`script-src 'self' ${NONCE_RE.source}`));
  ok(style, `style-src carries a nonce: ${csp}`);
  ok(script, `script-src carries a nonce: ${csp}`);
  strictEqual(style[1], script[1], "style/script share one request nonce");
  return style[1];
}

describe("preview security headers (TOG-5731)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("sends nosniff + framing denial + nonce CSP on the index page", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    strictEqual(res.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(res.headers.get("x-frame-options"), "DENY");
    const nonce = nonceOfCsp(res.headers.get("content-security-policy"));
    const body = await res.text();
    ok(body.includes(`<style nonce="${nonce}">`), "style tag carries the header nonce");
  });

  it("sends nosniff + framing denial + nonce CSP on the detail shell", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const first = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(first.status, 200);
    strictEqual(first.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(first.headers.get("x-frame-options"), "DENY");
    const nonce = nonceOfCsp(first.headers.get("content-security-policy"));
    const body = await first.text();
    ok(body.includes(`<style nonce="${nonce}">`), "style tag carries the header nonce");
    ok(body.includes(`<script nonce="${nonce}">`), "shell script carries the header nonce");
    // Fresh nonce per response: a leaked page source authorizes nothing else.
    const second = await fetch(`${base}/listings/northstar/alpha-chat`);
    const nonce2 = nonceOfCsp(second.headers.get("content-security-policy"));
    await second.text();
    notStrictEqual(nonce2, nonce, "nonces differ across responses");
  });

  it("sends framing denial + nonce CSP on HTML 404s, nosniff-only on JSON 404s", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Unknown listing (browser default): HTML 404.
    const miss = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(miss.status, 404);
    strictEqual(miss.headers.get("content-type"), "text/html; charset=utf-8");
    strictEqual(miss.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(miss.headers.get("x-frame-options"), "DENY");
    const nonce = nonceOfCsp(miss.headers.get("content-security-policy"));
    ok((await miss.text()).includes(`<style nonce="${nonce}">`), "404 style tag matches header");
    // Unknown path: JSON 404 with nosniff, no framing/CSP.
    const unknown = await fetch(`${base}/nope`);
    strictEqual(unknown.status, 404);
    strictEqual(unknown.headers.get("content-type"), "application/json; charset=utf-8");
    strictEqual(unknown.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(unknown.headers.get("x-frame-options"), null);
    strictEqual(unknown.headers.get("content-security-policy"), null);
    // TOG-5714 browser fallback (explicit text/html navigation): HTML 404
    // with its own fresh nonce, tags matching the header.
    const browserMiss = await fetch(`${base}/nope`, { headers: { accept: "text/html" } });
    strictEqual(browserMiss.status, 404);
    strictEqual(browserMiss.headers.get("content-type"), "text/html; charset=utf-8");
    strictEqual(browserMiss.headers.get("x-frame-options"), "DENY");
    const fallbackNonce = nonceOfCsp(browserMiss.headers.get("content-security-policy"));
    ok(
      (await browserMiss.text()).includes(`<style nonce="${fallbackNonce}">`),
      "fallback 404 style tag matches header",
    );
  });

  it("sends nosniff without framing/CSP on the purchase stub", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // 403 for a known listing, 404 for an unknown one — both JSON.
    for (const [path, status] of [
      ["/listings/northstar/alpha-chat/purchase", 403],
      ["/listings/northstar/nope/purchase", 404],
    ]) {
      const res = await fetch(`${base}${path}`, { method: "POST" });
      strictEqual(res.status, status, path);
      strictEqual(res.headers.get("content-type"), "application/json; charset=utf-8", path);
      strictEqual(res.headers.get("x-content-type-options"), NOSNIFF, path);
      strictEqual(res.headers.get("x-frame-options"), null, path);
      strictEqual(res.headers.get("content-security-policy"), null, path);
    }
  });

  it("sends nosniff on JSON 404s and the rate-limit refusal", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { rateLimit: { windowMs: 60_000, max: 1 } });
    const first = await fetch(`${base}/nope`);
    strictEqual(first.status, 404);
    strictEqual(first.headers.get("x-content-type-options"), NOSNIFF);
    // Second request to the same fallback bucket trips the limiter.
    const limited = await fetch(`${base}/nope`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(limited.headers.get("x-frame-options"), null);
    strictEqual(limited.headers.get("content-security-policy"), null);
  });
});
