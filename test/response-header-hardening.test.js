// TOG-8332: response-header hardening pin (CSP/HSTS/Referrer/Permissions).
//
// Audit verdict locked in as tests:
//   - Every response (HTML + JSON, 200/304/204/4xx/5xx incl. 429) carries
//     `Permissions-Policy` denying the powerful features the preview never
//     uses (camera/mic/geolocation/payment/usb).
//   - HSTS is deliberately ABSENT: the server binds plain HTTP only, and
//     per RFC 6797 §8.1 browsers ignore STS over insecure transport —
//     emitting it would imply a TLS guarantee the server does not provide.
//   - Pre-existing headers (nosniff everywhere, nonce CSP + framing denial
//     on HTML, `Referrer-Policy: no-referrer` everywhere) are pinned by
//     test/security-headers.test.js and test/listing-detail.test.js; this
//     file only pins the TOG-8332 delta so the audit cannot silently regress.
//
// node:test, zero dependencies, stub fixtures only.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

describe("response-header hardening audit pin (TOG-8332)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("sends deny-by-default Permissions-Policy on every response shape", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 100 } },
    );
    // HTML 200 (index + detail shell), cacheable JSON 200, HTML/JSON 404s,
    // JSON 403, and the header-only 204 favicon.
    const paths = [
      ["/listings", {}],
      ["/listings/northstar/alpha-chat", {}],
      ["/healthz", {}],
      ["/nope", {}],
      ["/nope", { headers: { accept: "text/html" } }],
      ["/listings/northstar/alpha-chat", { headers: { accept: "application/json" } }],
      ["/favicon.ico", {}],
    ];
    for (const [path, init] of paths) {
      const res = await fetch(`${base}${path}`, init);
      strictEqual(
        res.headers.get("permissions-policy"),
        PERMISSIONS_POLICY,
        `GET ${path}`,
      );
      // HSTS must stay absent on plain HTTP (RFC 6797 §8.1: ignored over
      // insecure transport; emitting it would fake a TLS guarantee).
      strictEqual(res.headers.get("strict-transport-security"), null, `GET ${path} no HSTS`);
    }
    const purchase = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
      method: "POST",
    });
    strictEqual(purchase.status, 403);
    strictEqual(purchase.headers.get("permissions-policy"), PERMISSIONS_POLICY, "POST purchase");
    strictEqual(purchase.headers.get("strict-transport-security"), null, "POST purchase no HSTS");
  });

  it("keeps Permissions-Policy on the 429 rate-limit refusal", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { rateLimit: { windowMs: 60_000, max: 1 } });
    const first = await fetch(`${base}/nope`);
    strictEqual(first.status, 404);
    const limited = await fetch(`${base}/nope`);
    strictEqual(limited.status, 429);
    strictEqual(limited.headers.get("permissions-policy"), PERMISSIONS_POLICY, "429 refusal");
    strictEqual(limited.headers.get("strict-transport-security"), null, "429 no HSTS");
  });

  it("keeps Permissions-Policy on the 304 revalidation path", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const first = await fetch(`${base}/healthz`);
    strictEqual(first.status, 200);
    const etag = first.headers.get("etag");
    strictEqual(typeof etag, "string");
    const revalidated = await fetch(`${base}/healthz`, {
      headers: { "if-none-match": etag },
    });
    strictEqual(revalidated.status, 304);
    strictEqual(
      revalidated.headers.get("permissions-policy"),
      PERMISSIONS_POLICY,
      "304 revalidation",
    );
  });
});
