// Host-header / X-Forwarded-Host handling audit (TOG-7304).
//
// The preview server must never trust Host/XFH for links, redirects, or
// rate-limit buckets: every link it emits is a same-origin relative path,
// it issues no redirects at all, and the limiter keys on the TCP peer (XFF
// only via the TOG-6029 trusted-proxy opt-in; Host/XFH never).
//
// This file pins that end to end at the HTTP layer with raw requests —
// fetch forbids overriding Host, so node:http carries the hostile values
// (loopback only, per CONTRIBUTING.md). A regression that echoes the header
// into a body/link, redirects through it, or keys a bucket on it fails here.
//
// node:test, zero dependencies.

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { request } from "node:http";
import { readFile } from "node:fs/promises";
import { createApp } from "../web/server.js";

// Hostile values: `.invalid` (RFC 2606) so even a bug that treated them as
// origins could never resolve; the digit run keeps rows distinct per test.
const EVIL_HOST = "hostile7304.example.invalid";
const EVIL_XFH = "x-poison7304.example.invalid";

function hostileHeaders(extra = {}) {
  return { host: EVIL_HOST, "x-forwarded-host": EVIL_XFH, ...extra };
}

function rawRequest(port, { method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(body, "utf8");
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(payload === null ? {} : { "content-length": String(payload.length) }),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

describe("Host / X-Forwarded-Host audit (TOG-7304)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server.address().port;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function readSellerFixture() {
    return JSON.parse(
      await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
    );
  }

  it("hostile Host/XFH leave no trace in the index HTML", async () => {
    const port = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await rawRequest(port, { path: "/listings", headers: hostileHeaders() });
    strictEqual(res.status, 200);
    ok(!res.text.includes(EVIL_HOST), "Host value must not appear in index HTML");
    ok(!res.text.includes(EVIL_XFH), "XFH value must not appear in index HTML");
    ok(!/href="https?:\/\//i.test(res.text), "index links must be relative, never absolute");
    ok(!/action="https?:\/\//i.test(res.text), "form targets must be relative, never absolute");
    strictEqual(res.headers.location ?? null, null, "no redirect may be issued");
  });

  it("hostile Host/XFH leave no trace in the detail shell or JSON fragment", async () => {
    const port = await start({ WAYSELECT_PREVIEW: "1" });
    const shell = await rawRequest(port, {
      path: "/listings/northstar/alpha-chat",
      headers: hostileHeaders(),
    });
    strictEqual(shell.status, 200);
    ok(!shell.text.includes(EVIL_HOST), "Host value must not appear in the detail shell");
    ok(!shell.text.includes(EVIL_XFH), "XFH value must not appear in the detail shell");
    // The shell's inline fetch must stay a same-origin relative path.
    ok(!/fetch\(\s*"https?:\/\//.test(shell.text), "fragment fetch must be a relative path");
    const fragment = await rawRequest(port, {
      path: "/listings/northstar/alpha-chat",
      headers: hostileHeaders({ accept: "application/json" }),
    });
    strictEqual(fragment.status, 200);
    ok(!fragment.text.includes(EVIL_HOST), "Host value must not appear in the fragment JSON");
    ok(!fragment.text.includes(EVIL_XFH), "XFH value must not appear in the fragment JSON");
  });

  it("hostile Host/XFH leave no trace in 404 pages (HTML and JSON)", async () => {
    const port = await start({ WAYSELECT_PREVIEW: "1" });
    const html404 = await rawRequest(port, {
      path: "/no-such-page-7304",
      headers: hostileHeaders({ accept: "text/html" }),
    });
    strictEqual(html404.status, 404);
    ok(!html404.text.includes(EVIL_HOST), "Host value must not appear in the 404 HTML page");
    ok(!html404.text.includes(EVIL_XFH), "XFH value must not appear in the 404 HTML page");
    const json404 = await rawRequest(port, {
      path: "/no-such-page-7304",
      headers: hostileHeaders(),
    });
    strictEqual(json404.status, 404);
    ok(!json404.text.includes(EVIL_HOST), "Host value must not appear in the 404 JSON body");
    ok(!json404.text.includes(EVIL_XFH), "XFH value must not appear in the 404 JSON body");
  });

  it("seller intake answers with a relative confirmPath, evil-free", async () => {
    const port = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readSellerFixture();
    const res = await rawRequest(port, {
      method: "POST",
      path: "/sellers/submissions",
      headers: hostileHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(res.status, 200);
    const payload = JSON.parse(res.text);
    strictEqual(
      payload.confirmPath,
      "/sellers/submissions/northstar/seller-chat/confirm",
      "confirmPath must be a fixed relative path, never Host-derived",
    );
    ok(!res.text.includes(EVIL_HOST), "Host value must not appear in the intake response");
    ok(!res.text.includes(EVIL_XFH), "XFH value must not appear in the intake response");
  });

  it("no route issues a redirect, even under hostile Host/XFH", async () => {
    const port = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readSellerFixture();
    const targets = [
      { method: "GET", path: "/healthz" },
      { method: "GET", path: "/favicon.ico" },
      { method: "GET", path: "/listings" },
      { method: "GET", path: "/listings/" },
      { method: "GET", path: "/listings/northstar/alpha-chat" },
      {
        method: "GET",
        path: "/listings/northstar/alpha-chat",
        headers: { accept: "application/json" },
      },
      { method: "GET", path: "/listings/northstar/no-such-model" },
      { method: "GET", path: "/unknown-path-7304" },
      { method: "GET", path: "/sellers/submissions/northstar/nope/confirm" },
      { method: "POST", path: "/listings/northstar/alpha-chat/purchase" },
      {
        method: "POST",
        path: "/sellers/submissions",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixtures.valid),
      },
    ];
    for (const target of targets) {
      const res = await rawRequest(port, {
        ...target,
        headers: hostileHeaders(target.headers ?? {}),
      });
      ok(
        res.status < 300 || res.status > 399,
        `${target.method} ${target.path} must not redirect (got ${res.status})`,
      );
      strictEqual(
        res.headers.location ?? null,
        null,
        `${target.method} ${target.path} must not carry a Location header`,
      );
      ok(!res.text.includes(EVIL_HOST), `${target.method} ${target.path} body must be Host-free`);
    }
  });

  it("rotating Host/XFH buys no rate-limit budget", async () => {
    const port = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    const first = await rawRequest(port, {
      path: "/listings",
      headers: hostileHeaders(),
    });
    strictEqual(first.status, 200);
    // Same TCP peer, new claimed identities: still the peer's bucket.
    for (const headers of [
      { host: "other7304.example.invalid", "x-forwarded-host": "other-x7304.example.invalid" },
      { host: EVIL_HOST, "x-forwarded-host": "third7304.example.invalid" },
      { "x-forwarded-host": EVIL_XFH },
    ]) {
      const res = await rawRequest(port, { path: "/listings", headers });
      strictEqual(res.status, 429, `rotated headers ${JSON.stringify(headers)} must not mint budget`);
      strictEqual(JSON.parse(res.text).error, "rate_limited");
    }
  });

  it("XFH mints no bucket even behind the trusted proxy (XFF does, XFH never)", async () => {
    // Behind the single trusted hop, XFF identities get distinct budgets —
    // but XFH must still be ignored entirely.
    const port = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 }, trustedProxyIp: "127.0.0.1" },
    );
    const first = await rawRequest(port, {
      path: "/listings",
      headers: { "x-forwarded-for": "9.9.9.9", "x-forwarded-host": EVIL_XFH },
    });
    strictEqual(first.status, 200);
    // Same XFF client, different XFH: same bucket, refused.
    const replay = await rawRequest(port, {
      path: "/listings",
      headers: { "x-forwarded-for": "9.9.9.9", "x-forwarded-host": "other-x7304.example.invalid" },
    });
    strictEqual(replay.status, 429);
    // A different XFF client keeps its own budget regardless of XFH.
    const other = await rawRequest(port, {
      path: "/listings",
      headers: { "x-forwarded-for": "10.10.10.10", "x-forwarded-host": EVIL_XFH },
    });
    strictEqual(other.status, 200);
  });
});
