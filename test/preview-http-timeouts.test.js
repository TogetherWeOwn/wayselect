// Slow-header/slow-body caps for the preview server (TOG-6713).
//
// `createApp()` sets conservative Node http timeouts (headersTimeout 10s,
// requestTimeout 120s — below Node's 60s/300s defaults) so a slowloris-style
// drip cannot hold a socket for minutes. The only timers that existed before
// were the fragment-delay dev knob, which fires after full receipt and
// protects nothing. This file pins:
//   1. the default values on every server `createApp()` builds, plus the
//      absence of a `clientError` listener (a listener would suppress Node's
//      default 408 + socket-destroy on expiry — see below);
//   2. the `httpTimeouts` override and the `configureHttpTimeouts` bounds;
//   3. the behavior: a dripping header gets 408 + socket close;
//   4. the non-goal: a fully-received slow response still completes, so the
//      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS dev knob is unaffected
//      (requestTimeout only fires on stalled receipt — no data moving).
//
// node:test, stdlib only. The drip test uses a raw `node:net` socket because
// fetch cannot send an incomplete header block. Node enforces
// headers/requestTimeout via a periodic sweep (default every 30s), so the
// drip test shortens the sweep on its throwaway server — set before listen,
// when the sweep is created. That knob is test-only and never ships in
// `createApp()`; the pinned values under test are the production ones.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { connect } from "node:net";
import { configureHttpTimeouts, createApp, HTTP_TIMEOUT_DEFAULTS } from "../web/server.js";

describe("preview http timeouts (TOG-6713)", () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("pins conservative defaults below Node's own on every server", () => {
    deepStrictEqual(
      { ...HTTP_TIMEOUT_DEFAULTS },
      { headersTimeout: 10_000, requestTimeout: 120_000 },
    );
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    strictEqual(server.headersTimeout, 10_000);
    strictEqual(server.requestTimeout, 120_000);
    // No `clientError` listener anywhere: on expiry Node answers 408 and
    // destroys the socket by default, but a listener takes over that path
    // and would silently keep drips alive. Pin the absence so a future
    // handler must re-prove the drop.
    strictEqual(
      server.listeners("clientError").length,
      0,
      "no clientError listener: Node's default 408 + destroy must stand",
    );
  });

  it("honors httpTimeouts overrides", () => {
    const server = createApp(
      { WAYSELECT_PREVIEW: "1" },
      { httpTimeouts: { headersTimeout: 2000, requestTimeout: 5000 } },
    );
    strictEqual(server.headersTimeout, 2000);
    strictEqual(server.requestTimeout, 5000);
  });

  it("rejects invalid timeout overrides", () => {
    for (const bad of [
      { headersTimeout: 0, requestTimeout: 5000 },
      { headersTimeout: -1, requestTimeout: 5000 },
      { headersTimeout: 1.5, requestTimeout: 5000 },
      { headersTimeout: "5000", requestTimeout: 5000 },
      { headersTimeout: 300, requestTimeout: 300_001 },
    ]) {
      throws(() => configureHttpTimeouts({}, bad), RangeError, JSON.stringify(bad));
    }
    // headersTimeout past requestTimeout inverts the caps — fail closed.
    throws(
      () => configureHttpTimeouts({}, { headersTimeout: 5000, requestTimeout: 1000 }),
      RangeError,
    );
    // Boundary: equal values are the tightest legal shape.
    deepStrictEqual(
      configureHttpTimeouts({}, { headersTimeout: 1000, requestTimeout: 1000 }),
      { headersTimeout: 1000, requestTimeout: 1000 },
    );
  });

  it("drops a dripping header: 408 then socket close", async () => {
    const server = createApp(
      { WAYSELECT_PREVIEW: "1" },
      { httpTimeouts: { headersTimeout: 300, requestTimeout: 600 } },
    );
    servers.push(server);
    server.connectionsCheckingInterval = 50;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sock = connect(server.address().port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    let received = "";
    sock.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    const closed = new Promise((resolve) => sock.once("close", () => resolve(true)));
    // Slowloris shape: headers start but never terminate — no blank line,
    // no body, nothing more ever sent.
    sock.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-drip: abc");
    let watchdog;
    const dropped = await Promise.race([
      closed,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    clearTimeout(watchdog);
    ok(dropped, "dripping-header socket must be closed by headersTimeout");
    ok(
      received.startsWith("HTTP/1.1 408"),
      `expected a 408, got ${JSON.stringify(received.slice(0, 60))}`,
    );
    sock.destroy();
  });

  it("leaves a fully-received slow response alone (fragment-delay knob unaffected)", async () => {
    // requestTimeout 800ms with a 1500ms post-receipt fragment delay: the
    // request is fully received instantly, so nothing stalls and the slow
    // fragment must still complete with 200.
    const server = createApp(
      { WAYSELECT_PREVIEW: "1", WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: "1500" },
      { httpTimeouts: { headersTimeout: 500, requestTimeout: 800 } },
    );
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/listings/northstar/alpha-chat`,
      { headers: { accept: "application/json" } },
    );
    strictEqual(res.status, 200);
    await res.text();
  });
});
