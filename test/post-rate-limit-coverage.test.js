// POST intake rate-limit coverage (TOG-7283).
//
// web/rate-limit.js budgets cover every POST intake route through the
// per-IP/per-route limiter in web/server.js (routeBucket): each POST shape
// gets its own bucket and the check runs before any handler. This file pins
// that each POST route carries its own per-IP budget — max passes, then
// 429 + Retry-After with the `rate_limited` body — and that saturating one
// POST bucket does not starve another.
//
// Buckets pinned:
//   POST /listings/:provider/:model/purchase
//   POST /sellers/submissions
//   POST /sellers/submissions/:provider/:model/confirm
//
// node:test, zero dependencies.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createApp } from "../web/server.js";

async function readSellerFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
}

describe("POST intake rate-limit coverage (TOG-7283)", () => {
  const servers = [];
  async function start(options) {
    const server = createApp({ WAYSELECT_PREVIEW: "1" }, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function assertRateLimited(res) {
    strictEqual(res.status, 429, "budget spent: same-IP POST must be refused");
    const header = res.headers.get("retry-after");
    ok(header !== null, "429 carries a Retry-After header");
    const retryAfter = Number(header);
    ok(
      Number.isInteger(retryAfter) && retryAfter >= 1,
      `Retry-After must be a positive integer, got ${header}`,
    );
    const body = await res.json();
    strictEqual(body.error, "rate_limited");
    strictEqual(body.retryAfterSec, retryAfter, "header and body must agree");
  }

  it("POST /listings/:provider/:model/purchase has a per-IP budget", async () => {
    const base = await start({ rateLimit: { windowMs: 60_000, max: 1 } });
    const url = `${base}/listings/northstar/alpha-chat/purchase`;
    const first = await fetch(url, { method: "POST" });
    strictEqual(first.status, 403, "known-listing purchase stub refuses with preview_only");
    strictEqual((await first.json()).error, "preview_only");
    await assertRateLimited(await fetch(url, { method: "POST" }));
  });

  it("POST /sellers/submissions has a per-IP budget", async () => {
    const base = await start({ rateLimit: { windowMs: 60_000, max: 1 } });
    const fixtures = await readSellerFixtures();
    const post = () =>
      fetch(`${base}/sellers/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixtures.valid),
      });
    const first = await post();
    strictEqual(first.status, 200, "valid intake stages its confirm intent");
    strictEqual((await first.json()).routeId, "northstar/seller-chat");
    await assertRateLimited(await post());
  });

  it("POST /sellers/submissions/:provider/:model/confirm has a per-IP budget", async () => {
    const base = await start({ rateLimit: { windowMs: 60_000, max: 1 } });
    const fixtures = await readSellerFixtures();
    const staged = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(staged.status, 200, "precondition: intent staged");
    await staged.json();
    const url = `${base}/sellers/submissions/northstar/seller-chat/confirm`;
    const first = await fetch(url, { method: "POST" });
    strictEqual(first.status, 200, "confirm records the staged intent");
    strictEqual((await first.json()).recorded, true);
    await assertRateLimited(await fetch(url, { method: "POST" }));
  });

  it("POST buckets are independent: saturating one does not starve another", async () => {
    const base = await start({ rateLimit: { windowMs: 60_000, max: 1 } });
    const purchaseUrl = `${base}/listings/northstar/alpha-chat/purchase`;
    const purchase = await fetch(purchaseUrl, { method: "POST" });
    strictEqual(purchase.status, 403);
    await purchase.json();
    await assertRateLimited(await fetch(purchaseUrl, { method: "POST" }));
    // The intake bucket is untouched by the purchase flood.
    const fixtures = await readSellerFixtures();
    const intake = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(intake.status, 200, "saturated purchase bucket must not starve intake");
    await intake.json();
  });
});
