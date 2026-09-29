// TOG-8336 (Gap §4/§8, parent TOG-8283 gap list): listing-detail render
// budget under the slow-network knob.
//
// What: with WAYSELECT_DETAIL_FRAGMENT_DELAY_MS=600, asserts the shell first
// paint stays fast (shell + 300ms control delay < SHELL_BUDGET_MS), the JSON
// fragment settles within FRAGMENT_TOTAL_BUDGET_MS with content intact, the
// delay was actually applied (fragment >= knob - tolerance), and the pure
// in-process render cost (shell + fragment builds, no server) stays trivial.
//
// Why: TOG-6380 pins index render, TOG-6036 pins select latency, TOG-7286
// pins concurrent delayed fragments — but nothing pinned a ceiling on a
// single detail render under the knob. test/listing-detail-loading.test.js
// only asserts the floor (fragment >= 500ms); a render regression (heavier
// shell, unbounded fragment) or a knob leak onto the shell would ship
// silently. Measured 2026-09-29: pure shell+fragment 0.021ms/op, shell
// 1–11ms / fragment knob+~1ms at every knob setting (unset/600/1500).
//
// Verifiability: halve SHELL_BUDGET_MS to 250ms locally and rerun — the fixed
// 300ms control delay alone exceeds it and the shell/pure-render tests fail
// loudly. Raise KNOB_MS to 3000 locally — the fragment exceeds
// FRAGMENT_TOTAL_BUDGET_MS and fails loudly.
//
// Runbook (when this trips): bisect recent listing-detail/server changes,
// profile renderListingDetailShell + listingDetailFragment, fix the
// regression — do NOT raise a budget without a recorded perf explanation on
// the card. Test/CI-only, no prod activation.
//
// node:test, stdlib only; server tests bind an ephemeral localhost port.

import test from "node:test";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import {
  listingDetailFragment,
  renderListingDetailShell,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

// Distinctive knob delay: the 600ms value matches the TOG-5499 shell/fast
// pin in test/listing-detail-loading.test.js.
const KNOB_MS = 600;

// Shell first paint must stay fast under the knob: the knob delays the
// fragment only, never the shell (contract in
// docs/wayselect-slow-network-knob.md). Generous vs the measured 1–11ms.
const SHELL_BUDGET_MS = 500;

// Fragment ceiling: knob + generous overhead for render + loopback. Measured
// ~601–603ms at knob 600. Far below anything a user would call a hang, far
// above CI timer variance.
const FRAGMENT_TOTAL_BUDGET_MS = 2000;

// Timer tolerance: allow the delay to fire slightly early on a busy loop.
const DELAY_TOLERANCE_MS = 100;

// Fixed control delay: proves the shell/pure-render time assertions trip
// (see header). Do NOT scale this with the budget — halving the budget must
// fail loudly.
const CONTROL_DELAY_MS = 300;

// Pure-render iterations: enough builds to catch a per-render regression
// while staying sub-millisecond in practice (measured ~0.02ms/op).
const PURE_RENDER_ITERATIONS = 100;

describe("slow-network render budget (TOG-8336)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it(`shell first paint + ${CONTROL_DELAY_MS}ms control delay completes within ${SHELL_BUDGET_MS}ms under knob ${KNOB_MS}`, async () => {
    const base = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(KNOB_MS),
    });
    const startMs = Date.now();
    await new Promise((resolve) => setTimeout(resolve, CONTROL_DELAY_MS));
    const res = await fetch(`${base}/listings/northstar/alpha-chat`);
    const elapsedMs = Date.now() - startMs;
    assert.equal(res.status, 200);
    assert.ok(
      (await res.text()).includes("skeleton-title"),
      "shell first paint intact under the knob",
    );
    assert.ok(
      elapsedMs < SHELL_BUDGET_MS,
      `Shell render regression: first paint took ${elapsedMs}ms, ` +
        `budget ${SHELL_BUDGET_MS}ms. The knob must never delay the shell — ` +
        `bisect recent listing-detail/server changes, fix the regression — ` +
        `do not raise the budget without a recorded perf explanation.`,
    );
  });

  it(`fragment at knob ${KNOB_MS} settles within ${FRAGMENT_TOTAL_BUDGET_MS}ms with content intact`, async () => {
    const base = await start({
      WAYSELECT_PREVIEW: "1",
      WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: String(KNOB_MS),
    });
    const startMs = Date.now();
    const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    const elapsedMs = Date.now() - startMs;
    assert.equal(res.status, 200);
    assert.ok(
      (await res.json()).html.includes("<h1>Alpha Chat</h1>"),
      "fragment content intact under the knob",
    );
    assert.ok(
      elapsedMs >= KNOB_MS - DELAY_TOLERANCE_MS,
      `knob not applied: fragment took ${elapsedMs}ms, expected >= ${KNOB_MS - DELAY_TOLERANCE_MS}ms`,
    );
    assert.ok(
      elapsedMs < FRAGMENT_TOTAL_BUDGET_MS,
      `Fragment render regression: delayed fragment took ${elapsedMs}ms, ` +
        `budget ${FRAGMENT_TOTAL_BUDGET_MS}ms (knob ${KNOB_MS}ms). Runbook: ` +
        `bisect recent listing-detail/server changes, profile the fragment ` +
        `path — do not raise the budget without a recorded perf explanation.`,
    );
  });
});

test(`pure shell+fragment builds (x${PURE_RENDER_ITERATIONS}) + ${CONTROL_DELAY_MS}ms control delay complete within ${SHELL_BUDGET_MS}ms (TOG-8336)`, async () => {
  const listing = getStubListing("northstar", "alpha-chat");
  assert.ok(listing, "stub listing must exist");
  const start = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, CONTROL_DELAY_MS));
  let shell;
  let fragment;
  for (let i = 0; i < PURE_RENDER_ITERATIONS; i += 1) {
    shell = renderListingDetailShell(listing);
    fragment = listingDetailFragment(listing);
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(shell.includes("skeleton-title"), "shell builds");
  assert.ok(fragment.html.includes("<h1>Alpha Chat</h1>"), "fragment builds");
  assert.ok(
    elapsedMs < SHELL_BUDGET_MS,
    `Pure render regression: ${PURE_RENDER_ITERATIONS} shell+fragment builds ` +
      `took ${elapsedMs.toFixed(1)}ms, budget ${SHELL_BUDGET_MS}ms. Runbook: ` +
      `profile renderListingDetailShell/listingDetailFragment, fix the ` +
      `regression — do not raise the budget without a recorded perf explanation.`,
  );
});
