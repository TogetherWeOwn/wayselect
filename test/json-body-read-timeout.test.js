// Bounded JSON body reads (TOG-6712, gap R4-06 from TOG-6636).
//
// `web/jsonBody.js` previously awaited `end` with no deadline: a declared
// `Content-Length` larger than the actual body hung the socket forever. The
// read now carries a total deadline (`options.readTimeoutMs`, default
// `MAX_JSON_BODY_READ_MS`) that fails closed with `body_timeout`; the prod
// seller route maps it to 408 (retryable) while `body_too_large` stays 413
// and everything else stays 400. This file pins:
//   1. the 10s default bound constant (+ the `src/index.js` re-export);
//   2. a zero-byte hang (declared length, nothing arrives) resolves
//      `body_timeout` within the bound, drains, and ignores a late `end`;
//   3. a trickling body (bytes arriving, just too slowly) still times out —
//      the bound is a total deadline, not an idle timer;
//   4. deterministically (fake timers): exactly one finite `setTimeout` is
//      armed per read and cleared on settle — no unbounded await anywhere;
//   5. invalid `readTimeoutMs` values throw `TypeError` like `maxBytes`;
//   6. end-to-end through the prod route: a declared-64/sent-10 body gets
//      408 `{error:"body_timeout"}` instead of hanging (raw `node:net`
//      socket, since fetch cannot send an incomplete body).
//
// node:test, stdlib only. The HTTP test takes ~10s (the prod default bound)
// by design — pre-fix it hangs forever, which is the bug under test.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { connect } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { readJsonBody } from "../web/jsonBody.js";
import { MAX_JSON_BODY_BYTES, MAX_JSON_BODY_READ_MS } from "../src/intakeLimits.js";
import * as srcIndex from "../src/index.js";
import { createApp } from "../web/server.js";

function hangingStream(extraHeaders = {}) {
  const stream = new PassThrough();
  stream.headers = {
    "content-type": "application/json",
    "content-length": "64",
    ...extraHeaders,
  };
  return stream;
}

describe("json body read timeout (TOG-6712)", () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("pins the 10s default read bound and its public re-export", () => {
    strictEqual(MAX_JSON_BODY_READ_MS, 10_000);
    strictEqual(srcIndex.MAX_JSON_BODY_READ_MS, 10_000);
    strictEqual(MAX_JSON_BODY_BYTES, 64 * 1024);
  });

  it("rejects invalid readTimeoutMs values fail-fast", async () => {
    for (const readTimeoutMs of [0, -1, Number.NaN, "100", null]) {
      let thrown = null;
      try {
        await readJsonBody(hangingStream(), { readTimeoutMs, timers: { setTimeout: () => { throw new Error("must not arm"); }, clearTimeout: () => {} } });
      } catch (error) {
        thrown = error;
      }
      ok(thrown instanceof TypeError, `readTimeoutMs=${String(readTimeoutMs)} must throw TypeError`);
    }
  });

  it("resolves body_timeout on a zero-byte hang (declared length never arrives)", async () => {
    const stream = hangingStream();
    const started = Date.now();
    const result = await readJsonBody(stream, { readTimeoutMs: 100 });
    ok(Date.now() - started < 5000, "hanging read must resolve within the bound, not hang");
    strictEqual(result.ok, false);
    strictEqual(result.code, "body_timeout");
    // Drained for socket reuse: the stream is left flowing.
    ok(stream.readableFlowing, "timed-out stream must be drained (resumed)");
    // A late `end` after the timeout must not flip the settled result.
    stream.end('{"late":true}');
    await new Promise((resolve) => setTimeout(resolve, 50));
    strictEqual(result.code, "body_timeout");
  });

  it("times out a trickling body: the bound is total, not idle", async () => {
    const stream = new PassThrough();
    stream.headers = { "content-type": "application/json" };
    const pending = readJsonBody(stream, { readTimeoutMs: 300 });
    // Bytes keep arriving (no idle stall), just slower than the bound.
    const trickle = setInterval(() => stream.write("x"), 100);
    const result = await pending;
    clearInterval(trickle);
    strictEqual(result.ok, false);
    strictEqual(result.code, "body_timeout");
    stream.destroy();
  });

  it("still parses a fast body and arms exactly one finite timer (fake timers)", async () => {
    let armedMs = null;
    let cleared = 0;
    let fire = null;
    const timers = {
      setTimeout: (fn, ms) => {
        armedMs = ms;
        fire = fn;
        return { unref: () => {} };
      },
      clearTimeout: () => {
        cleared += 1;
      },
    };
    const stream = Readable.from([Buffer.from('{"buyer":"mia"}')]);
    stream.headers = { "content-type": "application/json" };
    const result = await readJsonBody(stream, { readTimeoutMs: 250, timers });
    strictEqual(result.ok, true);
    strictEqual(result.value.buyer, "mia");
    strictEqual(armedMs, 250, "exactly one timer armed with the configured bound");
    strictEqual(cleared, 1, "timer cleared on settle so reads never leak handles");

    // Firing the captured timer on a hanging read settles body_timeout —
    // the timeout path exists and needs no real clock to prove.
    const hanging = hangingStream();
    const pending = readJsonBody(hanging, { readTimeoutMs: 250, timers });
    strictEqual(armedMs, 250);
    fire();
    const timedOut = await pending;
    strictEqual(timedOut.ok, false);
    strictEqual(timedOut.code, "body_timeout");
    hanging.destroy();
  });

  it("times out (408 body_timeout) rather than hanging on a short body over HTTP", async () => {
    // Prod default bound (10s): pre-fix this request hangs forever.
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const sock = connect(port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    let received = "";
    sock.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    const closed = new Promise((resolve) => sock.once("close", () => resolve(true)));
    // Declared 64 bytes, only 10 sent, then silence — the R4-06 hang shape.
    sock.write(
      "POST /sellers/submissions HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 64\r\n" +
        "Connection: close\r\n\r\n" +
        '{"half":1}',
    );
    const started = Date.now();
    let watchdog;
    const done = await Promise.race([
      closed,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(false), 30_000);
      }),
    ]);
    clearTimeout(watchdog);
    const elapsed = Date.now() - started;
    ok(done, "short-body request must resolve (408), not hang the socket");
    ok(elapsed < 20_000, `must resolve near the 10s bound, took ${elapsed}ms`);
    ok(received.startsWith("HTTP/1.1 408"), `expected a 408, got ${JSON.stringify(received.slice(0, 60))}`);
    ok(received.includes('"body_timeout"'), "408 body must name the body_timeout code");
    sock.destroy();
  });
});
