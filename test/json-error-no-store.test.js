// TOG-6367 (gap G6/S3): `Cache-Control: no-store` on dynamic JSON errors.
//
// `sendJson` (web/server.js) used to set content-type + nosniff only, so
// error bodies were storable by shared caches. Contract pinned here:
//   - Every JSON error (4xx/5xx via `sendJson`, the `sendMethodNotAllowed`
//     405 helper, and the inline 429 refusal) carries
//     `Cache-Control: no-store`.
//   - Fixture-deterministic success JSON (TOG-6050) carries the cacheable
//     contract (`public, max-age=60` + ETag + 304), pinned in
//     cacheable-get-etag.test.js — asserted there, not here.
//   - HTML pages are out of scope: no `Cache-Control` either way.
//
// node:test, zero dependencies.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const NO_STORE = "no-store";

describe("JSON error no-store (TOG-6367)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function cacheControl(base, path, init) {
    const res = await fetch(`${base}${path}`, init);
    await res.text();
    return { status: res.status, cacheControl: res.headers.get("cache-control") };
  }

  it("sends no-store on JSON 404s (fallback, listing miss, purchase miss)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of ["/nope", "/listings/northstar"]) {
      const miss = await cacheControl(base, path);
      strictEqual(miss.status, 404, path);
      strictEqual(miss.cacheControl, NO_STORE, `${path}: no-store`);
    }
    // Purchase miss is an unknown listing (known listings 403, pinned below).
    const purchaseMiss = await cacheControl(base, "/listings/northstar/nope/purchase", {
      method: "POST",
    });
    strictEqual(purchaseMiss.status, 404);
    strictEqual(purchaseMiss.cacheControl, NO_STORE, "purchase miss: no-store");
    // Fragment miss negotiated as JSON.
    const frag = await cacheControl(base, "/listings/northstar/nope", {
      headers: { accept: "application/json" },
    });
    strictEqual(frag.status, 404);
    strictEqual(frag.cacheControl, NO_STORE, "fragment miss: no-store");
  });

  it("sends no-store on the purchase 403 refusal", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await cacheControl(base, "/listings/northstar/alpha-chat/purchase", {
      method: "POST",
    });
    strictEqual(res.status, 403);
    strictEqual(res.cacheControl, NO_STORE, "403 preview_only: no-store");
  });

  it("sends no-store on 405s (helper routes incl. seller confirm)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Via sendMethodNotAllowed (Allow header present).
    const helper = await cacheControl(base, "/listings/northstar/alpha-chat/purchase");
    strictEqual(helper.status, 405);
    strictEqual(helper.cacheControl, NO_STORE, "helper 405: no-store");
    // TOG-5739: seller confirm now funnels through the helper too, so the
    // 405 carries `Allow: GET, POST` alongside no-store.
    const direct = await (async () => {
      const res = await fetch(`${base}/sellers/submissions/northstar/alpha-chat/confirm`, {
        method: "DELETE",
      });
      await res.text();
      return {
        status: res.status,
        cacheControl: res.headers.get("cache-control"),
        allow: res.headers.get("allow"),
      };
    })();
    strictEqual(direct.status, 405);
    strictEqual(direct.allow, "GET, POST", "seller confirm 405: Allow header");
    strictEqual(direct.cacheControl, NO_STORE, "seller confirm 405: no-store");
  });

  it("sends no-store on 400/413 seller-intake rejections", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const post = (body, contentType = "application/json") =>
      cacheControl(base, "/sellers/submissions", {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    // Malformed JSON → 400 malformed_json.
    const malformed = await post("{nope");
    strictEqual(malformed.status, 400);
    strictEqual(malformed.cacheControl, NO_STORE, "400 malformed_json: no-store");
    // Wrong content-type → 400 wrong_content_type.
    const wrongType = await post("{}", "text/plain");
    strictEqual(wrongType.status, 400);
    strictEqual(wrongType.cacheControl, NO_STORE, "400 wrong_content_type: no-store");
    // Invalid submission (well-formed JSON, fails validator) → 400.
    const invalid = await post(JSON.stringify({ nope: true }));
    strictEqual(invalid.status, 400);
    strictEqual(invalid.cacheControl, NO_STORE, "400 invalid_submission: no-store");
    // Oversize body (chunked, no content-length — fetch forbids
    // overriding content-length, so stream past the ~64KB cap) → 413.
    const oversize = await (async () => {
      const { request } = await import("node:http");
      const big = `{"pad":"${"x".repeat(64 * 1024)}"}`;
      return new Promise((resolve, reject) => {
        const url = new URL("/sellers/submissions", base);
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: { "content-type": "application/json" },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                cacheControl: res.headers["cache-control"],
                text: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.write(big.slice(0, 1000));
        req.write(big.slice(1000));
        req.end();
      });
    })();
    strictEqual(oversize.status, 413);
    strictEqual(JSON.parse(oversize.text).error, "body_too_large");
    strictEqual(oversize.cacheControl, NO_STORE, "413 body_too_large: no-store");
  });

  it("sends no-store on the 429 rate-limit refusal", async () => {
    const base = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 1 } },
    );
    const first = await cacheControl(base, "/nope");
    strictEqual(first.status, 404);
    const limited = await cacheControl(base, "/nope");
    strictEqual(limited.status, 429);
    strictEqual(limited.cacheControl, NO_STORE, "429: no-store");
  });

  it("sends no-store on method_not_allowed for /healthz", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await cacheControl(base, "/healthz", { method: "POST" });
    strictEqual(res.status, 405);
    strictEqual(res.cacheControl, NO_STORE, "/healthz 405: no-store");
  });

  it("leaves non-cacheable success JSON without server Cache-Control (TOG-6050 boundary)", async () => {
    // Fixture-deterministic GETs (/healthz, index JSON, fragment) carry the
    // TOG-6050 cacheable contract — pinned in cacheable-get-etag.test.js.
    // This test pins the other side: seller-transactional success JSON stays
    // validator-free (perishable intents, recordedAt stamps).
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const { readFile } = await import("node:fs/promises");
    const fixtures = JSON.parse(
      await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
    );
    const intake = await cacheControl(base, "/sellers/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(intake.status, 200);
    strictEqual(intake.cacheControl, null, "intake 200: no Cache-Control");
  });

  it("leaves HTML pages without Cache-Control", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const [path, status] of [["/listings", 200], ["/listings/northstar/nope", 404]]) {
      const res = await cacheControl(base, path);
      strictEqual(res.status, status, path);
      strictEqual(res.cacheControl, null, `${path}: no Cache-Control`);
    }
  });
});
