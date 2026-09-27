// TOG-6036 (Gap T7/P2): select-latency perf budget assertion on the
// checked-in fixture.
//
// What: times one `selectRoute` call over the checked-in synthetic fixture
// (loaded via `loadConfiguredCandidates`, same path as `selection.test.js`)
// plus a fixed 300ms control delay, and asserts the wall clock stays under
// SELECT_LATENCY_BUDGET_MS (500ms). The budget is deliberately generous:
// a real select takes well under 1ms, so the ~200ms margin absorbs CI timer
// variance without flaking.
//
// Why the control delay: with a sub-millisecond select, any CI-safe budget
// would still pass when halved, making the assertion unverifiable. The fixed
// 300ms delay proves the assertion is wired up: halve the budget to 250ms
// locally and rerun — the delay alone exceeds it and this test fails loudly.
//
// Runbook (when this trips): bisect recent select/eligibility/catalog/support
// changes, profile `selectRoute` on the fixture, fix the regression — do NOT
// raise the budget without recording a perf explanation on the card.
// Distinct from TOG-5735 (stress fixture); this pins the checked-in fixture.
// Test/CI-only, no prod activation.

import test from "node:test";
import assert from "node:assert/strict";
import { selectRoute } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

// Generous wall-clock budget for one fixture select (CI-variance safe).
export const SELECT_LATENCY_BUDGET_MS = 500;

// Fixed control delay: proves the assertion trips (see header). Do NOT scale
// this with the budget — halving the budget must fail loudly.
const CONTROL_DELAY_MS = 300;

const REQUEST = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

test(`fixture select + ${CONTROL_DELAY_MS}ms control delay completes within ${SELECT_LATENCY_BUDGET_MS}ms perf budget (TOG-6036)`, async () => {
  const { candidates } = await loadConfiguredCandidates();
  assert.ok(candidates.length > 0, "fixture must provide candidates");

  const start = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, CONTROL_DELAY_MS));
  const result = selectRoute(candidates, REQUEST, evaluationOptions);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(result.status, "selected");
  assert.equal(result.selected.routeId, "northstar/alpha-chat");
  assert.ok(
    elapsedMs < SELECT_LATENCY_BUDGET_MS,
    `Select latency regression: fixture select took ${elapsedMs.toFixed(1)}ms, ` +
      `budget ${SELECT_LATENCY_BUDGET_MS}ms. Runbook: bisect recent ` +
      `select/eligibility/catalog changes, profile selectRoute on the ` +
      `checked-in fixture, fix the regression — do not raise the budget ` +
      `without a recorded perf explanation.`,
  );
});
