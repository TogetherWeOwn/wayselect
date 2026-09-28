// Graceful-drain pins for the TOG-5726 preview shutdown path (TOG-8620).
//
// installShutdownHandlers stops accepting new connections on SIGTERM/SIGINT
// and exits 0 once in-flight requests drain (force-exiting 1 after a bounded
// grace period). The ops suite pins the exit codes; these tests pin the drain
// itself: an in-flight fragment request completes with its full body while a
// fresh connection is refused, and a hung server is force-exited.
//
// node:test, zero dependencies. Every wait is bounded (FAIL_BOUND_MS) so a
// regression fails instead of hanging the suite or leaving handles open.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { createApp, installShutdownHandlers } from "../web/server.js";

const LOOPBACK = "127.0.0.1";
// Server-side fragment delay (dev knob) that holds the request in flight long
// enough to land the signal mid-flight; every wait below fails after
// FAIL_BOUND_MS instead of hanging.
const FRAGMENT_DELAY_MS = 300;
const FAIL_BOUND_MS = 5000;

describe("preview shutdown drain (TOG-8620)", () => {
  const servers = [];
  const removers = [];
  after(async () => {
    for (const remove of removers.splice(0)) {
      remove();
    }
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  async function startDelayed() {
    const server = createApp(
      { WAYSELECT_PREVIEW: "1", WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(FRAGMENT_DELAY_MS) },
      { logger: () => {} },
    );
    servers.push(server);
    await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
    return server;
  }

  function install(server, exits) {
    // Fake force-exit timer: the drain path must win on its own merits, and
    // no real timer handle may outlive the test.
    const fakeTimers = {
      setTimeout: (fn) => ({ __fakeTimer: true, fn }),
      clearTimeout: () => {},
    };
    removers.push(installShutdownHandlers(server, { exit: (code) => exits.push(code), timers: fakeTimers }));
  }

  // Raw http with a fresh (non-pooled) connection: fetch() pools keep-alive
  // connections, which would let a "new" request ride the in-flight socket
  // and hide a failure to stop accepting.
  function getFragment(port) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: LOOPBACK,
          port,
          path: "/listings/northstar/alpha-chat",
          agent: false,
          headers: { accept: "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.setTimeout(FAIL_BOUND_MS, () => {
        req.destroy(new Error(`fragment response exceeded ${FAIL_BOUND_MS}ms bound`));
      });
    });
  }

  function probeFreshConnection(port) {
    return new Promise((resolve) => {
      const req = http.get({ host: LOOPBACK, port, path: "/healthz", agent: false }, (res) => {
        res.resume();
        resolve({ refused: false, status: res.statusCode });
      });
      req.on("error", (err) => resolve({ refused: true, code: err?.code }));
      req.setTimeout(FAIL_BOUND_MS, () => {
        req.destroy(new Error(`refusal probe exceeded ${FAIL_BOUND_MS}ms bound`));
      });
    });
  }

  async function waitForExit(exits) {
    const deadline = Date.now() + FAIL_BOUND_MS;
    while (exits.length === 0) {
      if (Date.now() >= deadline) {
        throw new Error(`exit after drain did not happen within ${FAIL_BOUND_MS}ms`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // One extra macrotask drain: a second exit (double-signal bug) would land
    // here and fail the exactly-once assertion below.
    await new Promise((r) => setImmediate(r));
    deepStrictEqual(exits, [0], "exactly one exit(0) after drain");
  }

  async function drainCase(signal) {
    const server = await startDelayed();
    const port = server.address().port;
    const exits = [];
    install(server, exits);

    // Hold a fragment request in flight (the server delays it
    // FRAGMENT_DELAY_MS). Loopback accept is sub-millisecond; 100ms
    // guarantees the server holds the request before the signal lands.
    const inFlight = getFragment(port);
    await new Promise((r) => setTimeout(r, 100));

    process.emit(signal);

    // Stops accepting: synchronously unlisted, and a fresh TCP connection is
    // refused (not queued, not answered).
    strictEqual(server.listening, false, `server must stop accepting on ${signal}`);
    const probe = await probeFreshConnection(port);
    deepStrictEqual(probe, { refused: true, code: "ECONNREFUSED" });

    // Drains: the in-flight request still completes with its full body.
    const drained = await inFlight;
    strictEqual(drained.status, 200, `in-flight fragment must complete after ${signal}`);
    const payload = JSON.parse(drained.body);
    ok(typeof payload.html === "string" && payload.html.length > 0, "fragment body must be intact");

    await waitForExit(exits);
  }

  it("SIGTERM stops accepting new connections while an in-flight fragment drains, then exits 0", async () => {
    await drainCase("SIGTERM");
  });

  it("SIGINT drains the same way (shared shutdown path)", async () => {
    await drainCase("SIGINT");
  });

  it("force-exits 1 when the server never drains within the grace period", () => {
    let closeCalled = false;
    // A server whose close callback never fires: the drain never completes.
    // installShutdownHandlers only uses server.close, so a stub suffices.
    const hungServer = {
      close: () => {
        closeCalled = true;
      },
    };
    const exits = [];
    let forceFire = null;
    const fakeTimers = {
      setTimeout: (fn) => {
        forceFire = fn;
        return { __fakeTimer: true };
      },
      clearTimeout: () => {},
    };
    removers.push(
      installShutdownHandlers(hungServer, {
        graceMs: 50,
        exit: (code) => exits.push(code),
        timers: fakeTimers,
      }),
    );
    process.emit("SIGTERM");
    ok(closeCalled, "server.close must be attempted on signal");
    deepStrictEqual(exits, [], "no exit before the grace period elapses");
    ok(typeof forceFire === "function", "a force-exit timer must be armed");
    forceFire();
    deepStrictEqual(exits, [1], "hung drain must force-exit 1");
  });
});
