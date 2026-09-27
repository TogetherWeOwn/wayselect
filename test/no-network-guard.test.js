import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// TOG-4800: self-test for the no-network guard preloaded by `npm test`.
// The guard itself only fires on accidental network use, so this test
// exercises the guard directly by attempting the covered calls and asserting
// each one throws. The only sanctioned networked path is the opt-in
// `wayselect catalog import --fetch`, which no test exercises.

const FORBIDDEN = /no-network guard/;

test("fetch is blocked under the no-network guard", async () => {
  await assert.rejects(globalThis.fetch("https://example.invalid/"), FORBIDDEN);
});

test("http/https request helpers are blocked", () => {
  assert.throws(() => http.request("https://example.invalid/"), FORBIDDEN);
  assert.throws(() => http.get("https://example.invalid/"), FORBIDDEN);
  assert.throws(() => https.request("https://example.invalid/"), FORBIDDEN);
  assert.throws(() => https.get("https://example.invalid/"), FORBIDDEN);
});

test("raw socket constructors are blocked", () => {
  assert.throws(() => net.connect(443, "example.invalid"), FORBIDDEN);
  assert.throws(() => net.createConnection(443, "example.invalid"), FORBIDDEN);
  assert.throws(() => tls.connect(443, "example.invalid"), FORBIDDEN);
});

test("loopback server traffic is allowed; non-loopback still blocked", async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("loopback-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await globalThis.fetch(`${base}/health`);
  assert.equal(await res.text(), "loopback-ok");

  // Non-loopback destinations still fail before any socket opens, including
  // the loopback-looking suffix attack ("localhost.example.invalid").
  await assert.rejects(globalThis.fetch("https://example.invalid/"), FORBIDDEN);
  await assert.rejects(
    globalThis.fetch("http://localhost.example.invalid/"),
    FORBIDDEN,
  );
  assert.throws(() => http.request("https://example.invalid/"), FORBIDDEN);
  assert.throws(() => net.connect(443, "localhost.example.invalid"), FORBIDDEN);
});
