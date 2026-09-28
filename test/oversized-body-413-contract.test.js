// 413 contract for oversized JSON POST bodies (TOG-8612).
//
// Audit result: the byte cap exists (`MAX_JSON_BODY_BYTES` in
// src/intakeLimits.js, enforced by `readJsonBody` in web/jsonBody.js) and
// the only prod HTTP mapping to 413 is the seller-intake route
// (web/server.js: `body_too_large` → 413; everything else → 400/408). The
// chat-completions gateway (src/gateway.js) is in-process only — no HTTP
// binding yet — so its oversized-payload protection is the semantic caps
// (TOG-7307, pinned in test/gateway-intake-limits.test.js), and any future
// HTTP binding must sit behind this same byte gate. No source fix needed.
//
// What was unpinned: no test hit the real HTTP gateway (the preview
// server via `createApp`) with a >limit body and asserted the *full* 413
// contract — status, machine-readable error shape
// (`{error,key,source,message}` plus the TOG-6717 `requestId`), and the
// hardening headers (`no-store`, `nosniff`, JSON content-type,
// `x-request-id` agreeing with the body). The request-id test titles a
// "400/413" case but only exercises the 400; the no-store test checks the
// 413 `error` field but not the full shape. This file closes both gaps,
// over both oversize paths (lying-or-huge declared `Content-Length` and
// chunked streaming with no length), plus socket reuse after refusal.
//
// node:test, zero dependencies beyond the app itself.
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { MAX_JSON_BODY_BYTES } from "../src/index.js";
import { createApp, REQUEST_ID_HEADER } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

// `{"pad":"..."}` envelope overhead is 10 bytes, so this pad length makes
// the serialized body exactly MAX + 1 bytes.
const OVER_PAD = MAX_JSON_BODY_BYTES - 10 + 1;
const OVER_BODY = `{"pad":"${"x".repeat(OVER_PAD)}"}`;

describe("oversized JSON body 413 contract (TOG-8612)", () => {
  const servers = [];
  async function start() {
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  // Chunked POST with full header control (fetch forbids overriding
  // content-length, which the declared-length fast path needs).
  function rawPost(base, headers, chunks) {
    const url = new URL("/sellers/submissions", base);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers,
        },
        (res) => {
          const body = [];
          res.on("data", (c) => body.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              contentType: res.headers["content-type"],
              cacheControl: res.headers["cache-control"],
              nosniff: res.headers["x-content-type-options"],
              requestId: res.headers[REQUEST_ID_HEADER],
              text: Buffer.concat(body).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      for (const chunk of chunks) {
        req.write(chunk);
      }
      req.end();
    });
  }

  // The full 413 contract: status, machine-readable shape, id, headers.
  function assertOversizeContract(reply, where) {
    strictEqual(reply.status, 413, `${where}: status`);
    strictEqual(reply.contentType, JSON_CT, `${where}: JSON content type`);
    strictEqual(reply.nosniff, "nosniff", `${where}: nosniff`);
    strictEqual(reply.cacheControl, "no-store", `${where}: no-store`);
    ok(REQUEST_ID_RE.test(reply.requestId ?? ""), `${where}: x-request-id is 32 lowercase hex`);
    const body = JSON.parse(reply.text);
    deepStrictEqual(
      body,
      {
        error: "body_too_large",
        key: "submission",
        source: null,
        message: "Seller submission rejected: body_too_large.",
        requestId: reply.requestId,
      },
      `${where}: machine-readable error shape with agreeing requestId`,
    );
  }

  it("pins the ~64KB limit constant the contract enforces", () => {
    strictEqual(MAX_JSON_BODY_BYTES, 64 * 1024);
    strictEqual(Buffer.byteLength(OVER_BODY), MAX_JSON_BODY_BYTES + 1);
  });

  it("413s a lying-or-huge declared content-length with the full error shape", async () => {
    const base = await start();
    const reply = await rawPost(
      base,
      {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      },
      ['{"buyer":"mia"}'],
    );
    assertOversizeContract(reply, "declared length");
  });

  it("413s a chunked streamed oversize body with the full error shape", async () => {
    const base = await start();
    const reply = await rawPost(
      base,
      { "content-type": "application/json" },
      [OVER_BODY.slice(0, 1000), OVER_BODY.slice(1000)],
    );
    assertOversizeContract(reply, "streamed");
  });

  it("survives oversized payloads: socket reusable, valid intake still 200s", async () => {
    const base = await start();
    for (let i = 0; i < 2; i++) {
      const refused = await rawPost(base, { "content-type": "application/json" }, [OVER_BODY]);
      strictEqual(refused.status, 413, `oversized POST ${i} must 413, not hang/crash`);
    }
    const fixtures = JSON.parse(
      await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
    );
    const res = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(res.status, 200, "valid intake after oversize refusals still serves");
    strictEqual(res.headers.get(REQUEST_ID_HEADER), null, "success carries no request id");
  });
});
