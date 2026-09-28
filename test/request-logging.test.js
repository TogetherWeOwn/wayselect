// Structured request logging (TOG-5739 slice): one JSON line per request
// via an injectable sink — `{method, path, status, latencyMs}`.
//
// node:test, zero dependencies. Lines are collected through
// `createApp(env, { logger })`; no stdout scraping. Server tests run under
// the no-network guard (loopback 127.0.0.1 fetches allowed).

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { connect } from "node:net";
import { createApp } from "../web/server.js";

describe("structured request logging (TOG-5739)", () => {
  const servers = [];
  async function start(env, options) {
    const lines = [];
    const server = createApp(env, {
      ...options,
      logger: (line) => lines.push(line),
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${server.address().port}`, lines };
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  function assertLineShape(line, { method, path, status }, where) {
    const entry = JSON.parse(line);
    strictEqual(entry.method, method, `${where}: method`);
    strictEqual(entry.path, path, `${where}: path`);
    strictEqual(entry.status, status, `${where}: status`);
    strictEqual(typeof entry.latencyMs, "number", `${where}: latencyMs is a number`);
    strictEqual(Number.isFinite(entry.latencyMs), true, `${where}: latencyMs is finite`);
    strictEqual(entry.latencyMs >= 0, true, `${where}: latencyMs is non-negative`);
  }

  it("logs one line per request with sane fields (200 path)", async () => {
    const { base, lines } = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/healthz`);
    strictEqual(res.status, 200);
    await res.text();
    strictEqual(lines.length, 1, "exactly one line per request");
    assertLineShape(lines[0], { method: "GET", path: "/healthz", status: 200 }, "GET /healthz");
  });

  it("logs 404, 405 and 429 paths with matching status", async () => {
    const { base, lines } = await start(
      { WAYSELECT_PREVIEW: "1" },
      { rateLimit: { windowMs: 60_000, max: 2 } },
    );
    const notFound = await fetch(`${base}/nope`);
    strictEqual(notFound.status, 404);
    await notFound.text();
    // Purchase route is POST-only; GET is a 405 with `Allow: POST`.
    const wrongMethod = await fetch(`${base}/listings/northstar/alpha-chat/purchase`);
    strictEqual(wrongMethod.status, 405);
    await wrongMethod.text();
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    strictEqual((await fetch(`${base}/listings`)).status, 200);
    // Budgets are per-route; the index bucket saturates on the third hit.
    strictEqual((await fetch(`${base}/listings`)).status, 429);
    strictEqual(lines.length, 5, "every request logs, including refusals");
    assertLineShape(lines[0], { method: "GET", path: "/nope", status: 404 }, "404 path");
    assertLineShape(
      lines[1],
      { method: "GET", path: "/listings/northstar/alpha-chat/purchase", status: 405 },
      "405 path",
    );
    assertLineShape(lines[4], { method: "GET", path: "/listings", status: 429 }, "429 path");
  });

  it("logs the raw target when it is unparseable", async () => {
    const { base, lines } = await start({ WAYSELECT_PREVIEW: "1" });
    const port = new URL(base).port;
    const statusLine = await new Promise((resolve, reject) => {
      const sock = connect(Number(port), "127.0.0.1", () =>
        sock.write("GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
      );
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk;
      });
      sock.on("close", () => resolve(buf.split("\r\n")[0]));
      sock.on("error", reject);
    });
    strictEqual(statusLine, "HTTP/1.1 404 Not Found");
    strictEqual(lines.length, 1, "raw-target request still logs one line");
    assertLineShape(lines[0], { method: "GET", path: "http://[::1", status: 404 }, "raw target");
  });

  it("reports honest latency on the delayed fragment path", async () => {
    const delayMs = 120;
    const { base, lines } = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(delayMs),
    });
    const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    strictEqual(res.status, 200);
    await res.text();
    strictEqual(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    strictEqual(entry.path, "/listings/northstar/alpha-chat");
    strictEqual(
      entry.latencyMs >= delayMs,
      true,
      `fragment latency ${entry.latencyMs}ms must cover the ${delayMs}ms delay`,
    );
  });
});
