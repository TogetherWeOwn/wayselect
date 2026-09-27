// Detail-fragment abort cleanup (TOG-6714, gap R4-08).
//
// Gap: the `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` slow-network knob arms a
// `setTimeout` per JSON fragment request, but nothing cleared it when the
// client disconnected — every aborted stream left a pending timer whose
// send wrote to a dead socket. This file pins:
//   1. an aborted delayed fragment leaves zero pending fragment timers
//      (the timer is created, then cleared — never fired);
//   2. the no-regression side: a normal delayed fragment still completes
//      with 200 + content after the fix (the `req` 'close' listener that
//      also fires on normal completion removes itself when the timer
//      fires, so healthy fragments are unaffected).
//
// node:test, zero dependencies. Localhost only (CONTRIBUTING.md: server
// tests bind an ephemeral port on 127.0.0.1). The abort test wraps the
// globals `setTimeout`/`clearTimeout` for its own window only, and
// filters tracked timers by the distinctive fragment delay so runner
// internals never collide. The abort fires only after the fragment timer
// is observed armed, so there is no arm-vs-abort race.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

// Distinctive delay: no runner-internal timer uses exactly this value,
// so the `delay === FRAGMENT_DELAY_MS` filter only ever matches the
// fragment timer under test.
const FRAGMENT_DELAY_MS = 617;

describe("detail-fragment abort cleanup (TOG-6714)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("an aborted delayed fragment leaves zero pending fragment timers", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const created = [];
    const cleared = new Set();
    globalThis.setTimeout = (fn, ms, ...rest) => {
      const rec = { delay: ms, fired: false, timer: null };
      rec.timer = realSetTimeout(
        (...args) => {
          rec.fired = true;
          return fn(...args);
        },
        ms,
        ...rest,
      );
      created.push(rec);
      return rec.timer;
    };
    globalThis.clearTimeout = (timer) => {
      cleared.add(timer);
      return realClearTimeout(timer);
    };
    try {
      const base = await start({
        WAYSELECT_PREVIEW: "1",
        WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(FRAGMENT_DELAY_MS),
      });
      const controller = new AbortController();
      const pending = fetch(`${base}/listings/northstar/alpha-chat`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      // Wait until the server has armed the fragment timer, then abort:
      // the request reached the server (headers fully sent) and the
      // delay is pending, so the abort exercises the cleanup path.
      const deadline = Date.now() + 2000;
      while (!created.some((rec) => rec.delay === FRAGMENT_DELAY_MS)) {
        if (Date.now() > deadline) {
          throw new Error("fragment timer was never armed");
        }
        await new Promise((r) => realSetTimeout(r, 10));
      }
      controller.abort();
      await pending.then(
        () => {
          throw new Error("aborted fetch unexpectedly succeeded");
        },
        () => {},
      );
      // Wait past the delay: an unleaked timer would have fired by now.
      await new Promise((r) => realSetTimeout(r, FRAGMENT_DELAY_MS + 400));
      const fragmentTimers = created.filter((rec) => rec.delay === FRAGMENT_DELAY_MS);
      strictEqual(fragmentTimers.length, 1, "exactly one fragment timer armed");
      const [rec] = fragmentTimers;
      strictEqual(rec.fired, false, "aborted fragment timer never fired (no wasted send)");
      ok(cleared.has(rec.timer), "aborted fragment timer was cleared (zero pending)");
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it("a normal delayed fragment still completes after the fix", async () => {
    const base = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(FRAGMENT_DELAY_MS),
    });
    const started = Date.now();
    const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    const elapsed = Date.now() - started;
    strictEqual(res.status, 200);
    ok(elapsed >= FRAGMENT_DELAY_MS - 100, `fragment still delayed (took ${elapsed}ms)`);
    const payload = await res.json();
    ok(payload.html.includes("<h1>Alpha Chat</h1>"), "fragment content intact");
  });
});
