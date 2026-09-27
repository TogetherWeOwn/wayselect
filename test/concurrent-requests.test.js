// Concurrent-request coverage (TOG-6379, gap T1 from TOG-6346).
//
// Parallel index/detail/purchase hits were unexercised: this file pins that
// concurrent requests share one limiter budget per bucket and that every
// parallel HTML response still mints its own fresh CSP nonce.
//
//   1. Same-bucket parallelism shares the budget: max=N parallel hits on one
//      route yield exactly N passes and the rest 429s (each with Retry-After
//      + matching body) — no double-spend, no lost decrement.
//   2. Parallel HTML responses carry pairwise-unique nonces, each matching
//      its own body's inline tags (a leaked page authorizes nothing else,
//      even under concurrency).
//   3. Parallel mixed-route hits keep per-route isolation: saturating the
//      index bucket does not starve detail or purchase.
//
// node:test, zero dependencies. Deterministic: Node serves the socket queue
// sequentially, so parallel dispatch still yields exact allow/refuse counts.

import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

// Minimal CSP-nonce extraction (mirrors test/security-headers.test.js):
// style-src and script-src must allowlist exactly one shared request nonce.
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

describe("concurrent requests (TOG-6379)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("parallel same-bucket hits share one budget: exactly max pass, rest 429", async () => {
    const max = 5;
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max } },
    );
    // Fire more parallel hits than the budget holds, all at once.
    const fired = 8;
    const results = await Promise.all(
      Array.from({ length: fired }, () => fetch(`${base}/listings`)),
    );
    const statuses = results.map((res) => res.status);
    const passed = statuses.filter((s) => s === 200).length;
    const refused = statuses.filter((s) => s === 429).length;
    strictEqual(passed, max, `exactly ${max} parallel hits must pass, got ${statuses}`);
    strictEqual(refused, fired - max, `the remaining ${fired - max} must be refused`);
    // Every refusal carries an exact, matching Retry-After verdict.
    for (const res of results.filter((r) => r.status === 429)) {
      const header = res.headers.get("retry-after");
      ok(header !== null, "each parallel 429 carries a Retry-After header");
      const retryAfter = Number(header);
      ok(Number.isInteger(retryAfter) && retryAfter >= 1, `positive-integer Retry-After, got ${header}`);
      strictEqual((await res.json()).retryAfterSec, retryAfter, "header and body agree");
    }
    // Drain bodies of the passes so sockets close cleanly.
    await Promise.all(results.filter((r) => r.status === 200).map((r) => r.text()));
  });

  it("parallel HTML responses mint pairwise-unique nonces matching their bodies", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const count = 6;
    const indexReqs = Array.from({ length: count }, () =>
      fetch(`${base}/listings`).then(async (res) => {
        strictEqual(res.status, 200);
        return { csp: res.headers.get("content-security-policy"), body: await res.text() };
      }),
    );
    const detailReqs = Array.from({ length: count }, () =>
      fetch(`${base}/listings/northstar/alpha-chat`).then(async (res) => {
        strictEqual(res.status, 200);
        return { csp: res.headers.get("content-security-policy"), body: await res.text() };
      }),
    );
    const pages = await Promise.all([...indexReqs, ...detailReqs]);
    const nonces = pages.map((page) => nonceOfCsp(page.csp));
    strictEqual(
      new Set(nonces).size,
      pages.length,
      `all ${pages.length} parallel responses must carry distinct nonces`,
    );
    for (const [i, page] of pages.entries()) {
      ok(
        page.body.includes(`<style nonce="${nonces[i]}">`),
        `parallel response ${i}: style tag carries its own header nonce`,
      );
    }
    // Detail shells additionally stamp the nonce on the inline script.
    for (const [i, page] of pages.slice(count).entries()) {
      ok(
        page.body.includes(`<script nonce="${nonces[count + i]}">`),
        `parallel detail ${i}: script tag carries its own header nonce`,
      );
    }
  });

  it("parallel mixed-route hits keep per-route isolation under saturation", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 2 } },
    );
    // Saturate the index bucket and hit detail + purchase concurrently.
    const [indexResults, detailRes, purchaseRes] = await Promise.all([
      Promise.all([
        fetch(`${base}/listings`),
        fetch(`${base}/listings`),
        fetch(`${base}/listings`),
      ]),
      fetch(`${base}/listings/northstar/alpha-chat`),
      fetch(`${base}/listings/northstar/alpha-chat/purchase`, { method: "POST" }),
    ]);
    const indexStatuses = indexResults.map((res) => res.status).sort();
    deepStrictEqual(indexStatuses, [200, 200, 429], "index bucket spends exactly its own budget");
    await Promise.all(indexResults.map((res) => res.text()));
    // Detail and purchase buckets are untouched by the index flood.
    strictEqual(detailRes.status, 200);
    await detailRes.text();
    strictEqual(purchaseRes.status, 403, "known-listing purchase stub still refuses with preview_only");
    strictEqual((await purchaseRes.json()).error, "preview_only");
  });
});
