// Tests for the TOG-5731 preview security headers.
//
// Contract (documented in web/server.js):
//   - Every response (HTML and JSON, including 429 refusals) carries
//     `X-Content-Type-Options: nosniff`.
//   - HTML responses additionally deny framing (`X-Frame-Options: DENY`
//     plus `frame-ancestors 'none'`) and carry a minimal CSP.
//   - JSON responses carry no framing/CSP headers (nothing to frame).
//
// node:test, zero dependencies.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const NOSNIFF = "nosniff";
// Keep in sync with HTML_SECURITY_HEADERS in web/server.js.
const HTML_CSP =
  "default-src 'self'; frame-ancestors 'none'; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
  "img-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'";

describe("preview security headers (TOG-5731)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("sends nosniff + framing denial + CSP on the index page", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    strictEqual(res.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(res.headers.get("x-frame-options"), "DENY");
    strictEqual(res.headers.get("content-security-policy"), HTML_CSP);
  });

  it("sends nosniff + framing denial + CSP on the detail shell", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    strictEqual(res.status, 200);
    strictEqual(res.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(res.headers.get("x-frame-options"), "DENY");
    strictEqual(res.headers.get("content-security-policy"), HTML_CSP);
  });

  it("sends framing denial + CSP on HTML 404s, nosniff-only on JSON 404s", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Unknown listing (browser default): HTML 404.
    const miss = await fetch(`${base}/listings/northstar/nope`);
    strictEqual(miss.status, 404);
    strictEqual(miss.headers.get("content-type"), "text/html; charset=utf-8");
    strictEqual(miss.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(miss.headers.get("x-frame-options"), "DENY");
    strictEqual(miss.headers.get("content-security-policy"), HTML_CSP);
    // Unknown path: JSON 404 with nosniff, no framing/CSP.
    const unknown = await fetch(`${base}/nope`);
    strictEqual(unknown.status, 404);
    strictEqual(unknown.headers.get("content-type"), "application/json; charset=utf-8");
    strictEqual(unknown.headers.get("x-content-type-options"), NOSNIFF);
    strictEqual(unknown.headers.get("x-frame-options"), null);
    strictEqual(unknown.headers.get("content-security-policy"), null);
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
