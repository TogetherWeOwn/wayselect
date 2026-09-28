// HTTP 413 `body_too_large` mapping tests (TOG-6031, gap T3 from TOG-6013).
//
// `web/jsonBody.js:12-17` documents the contract: `readJsonBody` returns
// `{ok:false, code}` and the route maps `body_too_large` to HTTP 413 (every
// other failure maps to 400). `test/intake-hardening.test.js` pins the
// intake half (codes); this file pins the HTTP half against a minimal
// in-process server that implements exactly that documented mapping — no
// prod route reads a body yet, so there is no prod mapping to pin.
//
// Mapping under test (test-only harness, mirrors the jsonBody doc):
//   body_too_large    → 413 {error:"body_too_large"}
//   wrong_content_type/malformed_json → 400 {error:<code>}
//   ok                → 200 {ok:true, value}
//
// Manual repro (what the reviewer runs): start any server that applies the
// mapping above, then
//   node -e 'fetch("http://127.0.0.1:PORT/echo",{method:"POST",
//     headers:{"content-type":"application/json"},
//     body:JSON.stringify({pad:"x".repeat(65536)})}).then(async r =>
//     console.log(r.status, await r.text()))'
//   → 413 {"error":"body_too_large"}
//
// node:test, zero dependencies.

import { strictEqual, ok } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer, request } from "node:http";
import { readJsonBody } from "../web/jsonBody.js";
import { MAX_JSON_BODY_BYTES } from "../src/intakeLimits.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function startMappingServer() {
  const server = createServer(async (req, res) => {
    let pathname = null;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = null;
    }
    if (req.method !== "POST" || pathname !== "/echo") {
      res.writeHead(404, { "content-type": JSON_CONTENT_TYPE });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const result = await readJsonBody(req);
    if (!result.ok) {
      const status = result.code === "body_too_large" ? 413 : 400;
      res.writeHead(status, {
        "content-type": JSON_CONTENT_TYPE,
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({ error: result.code }));
      return;
    }
    res.writeHead(200, {
      "content-type": JSON_CONTENT_TYPE,
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ ok: true, value: result.value }));
  });
  return server;
}

// Raw request with full header control (fetch forbids overriding
// content-length, which the declared-length fast path needs).
function rawPost(port, { headers, chunks }) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/echo", method: "POST", headers },
      (res) => {
        const body = [];
        res.on("data", (c) => body.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"],
            nosniff: res.headers["x-content-type-options"],
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

function jsonOf(response) {
  return JSON.parse(response.text);
}

describe("413 body_too_large HTTP mapping (TOG-6031)", () => {
  const servers = [];
  async function start() {
    const server = startMappingServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server.address().port;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("pins the ~64KB cap constant the mapping enforces", () => {
    strictEqual(MAX_JSON_BODY_BYTES, 64 * 1024);
  });

  it("maps a lying-or-huge declared content-length to 413 JSON", async () => {
    const port = await start();
    const res = await rawPost(port, {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      },
      chunks: ['{"buyer":"mia"}'],
    });
    strictEqual(res.status, 413);
    strictEqual(res.contentType, JSON_CONTENT_TYPE);
    strictEqual(res.nosniff, "nosniff");
    strictEqual(jsonOf(res).error, "body_too_large");
  });

  it("maps a streamed oversize body (chunked, no content-length) to 413 JSON", async () => {
    const port = await start();
    const big = `{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;
    ok(Buffer.byteLength(big) > MAX_JSON_BODY_BYTES);
    const res = await rawPost(port, {
      headers: { "content-type": "application/json" },
      chunks: [big.slice(0, 1000), big.slice(1000)],
    });
    strictEqual(res.status, 413);
    strictEqual(res.contentType, JSON_CONTENT_TYPE);
    strictEqual(jsonOf(res).error, "body_too_large");
  });

  it("pins the boundary: exactly MAX bytes parses, MAX+1 streamed byte 413s", async () => {
    const port = await start();
    // `{"pad":"..."}` overhead is 10 bytes, so pad to exactly MAX.
    const atCap = `{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES - 10)}"}`;
    strictEqual(Buffer.byteLength(atCap), MAX_JSON_BODY_BYTES);
    const okRes = await rawPost(port, {
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(atCap)),
      },
      chunks: [atCap],
    });
    strictEqual(okRes.status, 200);
    strictEqual(jsonOf(okRes).ok, true);

    const overCap = `{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES - 10 + 1)}"}`;
    strictEqual(Buffer.byteLength(overCap), MAX_JSON_BODY_BYTES + 1);
    const bigRes = await rawPost(port, {
      headers: { "content-type": "application/json" },
      chunks: [overCap],
    });
    strictEqual(bigRes.status, 413);
    strictEqual(jsonOf(bigRes).error, "body_too_large");
  });

  it("keeps body_too_large the only 413: other failures stay 400", async () => {
    const port = await start();
    const wrongType = await rawPost(port, {
      headers: { "content-type": "text/plain", "content-length": "5" },
      chunks: ["hello"],
    });
    strictEqual(wrongType.status, 400);
    strictEqual(jsonOf(wrongType).error, "wrong_content_type");

    const malformed = await rawPost(port, {
      headers: { "content-type": "application/json", "content-length": "9" },
      chunks: ["{not-json"],
    });
    strictEqual(malformed.status, 400);
    strictEqual(jsonOf(malformed).error, "malformed_json");
  });

  it("survives oversized payloads: no parser crash, socket reusable", async () => {
    const port = await start();
    const big = `{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;
    for (let i = 0; i < 2; i++) {
      const refused = await rawPost(port, {
        headers: { "content-type": "application/json" },
        chunks: [big],
      });
      strictEqual(refused.status, 413, `oversized POST ${i} must 413, not hang/crash`);
    }
    // The server still parses the next valid body on a fresh request.
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"buyer":"mia","price":12}',
    });
    strictEqual(res.status, 200);
    strictEqual(res.headers.get("content-type"), JSON_CONTENT_TYPE);
    const payload = await res.json();
    strictEqual(payload.ok, true);
    strictEqual(payload.value.buyer, "mia");
  });
});
