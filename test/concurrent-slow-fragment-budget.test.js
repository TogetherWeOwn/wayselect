// Concurrent slow-fragment load budget (TOG-7286).
//
// Gap: the WAYSELECT_DETAIL_FRAGMENT_DELAY_MS knob was pinned for one
// client at a time (TOG-5499, TOG-6383, TOG-6714) and concurrency was
// pinned without the delay (TOG-6379), but nothing fired N>=10 fragment
// requests concurrently WITH the delay set. A regression that serialized
// delayed fragments (or errored under parallel load) would ship silently.
//
// This file pins the budget: CLIENTS concurrent JSON-fragment hits with
// the delay knob set all return 200 with intact content (zero-error
// budget), and the whole batch completes far faster than N x delay
// (proving the timers run concurrently, not serialized).
//
// Verifiability: set BATCH_BUDGET_MS below FRAGMENT_DELAY_MS locally and
// rerun — the batch cannot beat a single delay, so the assertion fails
// loudly. Drop CLIENTS below BATCH_CLIENTS and the N>=10 guard fails.
//
// node:test, zero dependencies. Localhost only (CONTRIBUTING.md: server
// tests bind an ephemeral port on 127.0.0.1).

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

// Concurrent clients: the card acceptance floor is N>=10.
const BATCH_CLIENTS = 12;

// Distinctive delay: no runner-internal timer uses exactly this value.
const FRAGMENT_DELAY_MS = 250;

// Batch budget: generous vs the measured ~300ms concurrent batch, but far
// below the N x delay (~3000ms) a serialized implementation would cost.
// A serialized fragment path fails here by design. Do NOT raise this
// without recording a perf explanation on the card.
const BATCH_BUDGET_MS = 2000;

// Per-request ceiling: one fragment must never stall the batch.
const PER_REQUEST_BUDGET_MS = 2000;

// Timer tolerance: allow the delay to fire slightly early on a busy loop.
const DELAY_TOLERANCE_MS = 100;

describe("concurrent slow-fragment load budget (TOG-7286)", () => {
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

  it(`serves ${BATCH_CLIENTS} concurrent delayed fragments with zero errors inside ${BATCH_BUDGET_MS}ms`, async () => {
    ok(BATCH_CLIENTS >= 10, `acceptance floor is N>=10 concurrent clients (got ${BATCH_CLIENTS})`);
    const base = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(FRAGMENT_DELAY_MS),
    });
    const batchStart = Date.now();
    const results = await Promise.all(
      Array.from({ length: BATCH_CLIENTS }, async () => {
        const begin = Date.now();
        const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
          headers: { accept: "application/json" },
        });
        const elapsed = Date.now() - begin;
        const payload = res.status === 200 ? await res.json() : null;
        return { status: res.status, elapsed, payload };
      }),
    );
    const batchMs = Date.now() - batchStart;

    // Error budget: zero failures across the batch.
    const failures = results.filter((r) => r.status !== 200);
    strictEqual(failures.length, 0, `zero-error budget: all ${BATCH_CLIENTS} fragments must be 200, got ${failures.length} failures`);
    for (const [i, r] of results.entries()) {
      ok(
        r.payload?.html?.includes("<h1>Alpha Chat</h1>"),
        `fragment ${i}: content intact under concurrent delayed load`,
      );
      ok(
        r.elapsed >= FRAGMENT_DELAY_MS - DELAY_TOLERANCE_MS,
        `fragment ${i}: delay applied under concurrency (took ${r.elapsed}ms)`,
      );
      ok(
        r.elapsed < PER_REQUEST_BUDGET_MS,
        `fragment ${i}: per-request ceiling (took ${r.elapsed}ms, budget ${PER_REQUEST_BUDGET_MS}ms)`,
      );
    }

    // Latency budget: the concurrent batch must complete far faster than
    // N serialized delays — timers run in parallel, not in a queue.
    ok(
      batchMs < BATCH_BUDGET_MS,
      `Concurrent load regression: ${BATCH_CLIENTS} delayed fragments took ${batchMs}ms, ` +
        `budget ${BATCH_BUDGET_MS}ms (serialized cost would be ~${BATCH_CLIENTS * FRAGMENT_DELAY_MS}ms). ` +
        `Runbook: bisect recent listing-detail/server changes for serialized ` +
        `fragment handling — do not raise the budget without a recorded ` +
        `perf explanation.`,
    );
  });
});
