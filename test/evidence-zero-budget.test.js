// TOG-8624: zero/negative maxEvidenceAgeHours fail-closed pin (test-only).
//
// Exact behavior pinned against `src/eligibility.js` (`normalizeOptions` +
// `evidenceReasons`) and `bin/wayselect` (`parseMaxEvidenceAgeMs`):
// - A zero evidence budget is valid input and means "only this instant
//   counts": every aged observation yields `stale-evidence`, while an
//   observation at exactly `now` (age 0ms, `ageMs > 0` false) still passes.
//   Zero must never be read as "no limit" (everything fresh) — e.g. a falsy
//   `if (!maxEvidenceAgeMs)` shortcut would fail these pins open.
// - A negative, NaN, or Infinity budget is rejected at the boundary with a
//   typed error — never coerced to zero, and never treated as "no limit".
//   (Invalid maxCatalogAgeMs budgets are pinned separately by TOG-6722.)
//
// node:test, zero dependencies beyond the repo's own src/ modules plus one
// CLI subprocess per CLI case. No network. Refresh-proof clock:
// `evaluationNow()` sits two hours after the live fixture snapshot, so
// provenance refreshes never break these tests (the freshest fixture
// evidence is ~24h old, firmly stale under a zero budget).

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  EligibilityRequestError,
  evaluateEligibility,
} from "../src/index.js";
import {
  evaluationNow,
  loadConfiguredCandidates,
} from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const defaultRequest = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

function zeroBudgetOptions(now) {
  return { now, maxEvidenceAgeMs: 0, skipCatalogCheck: true };
}

test("TOG-8624: zero maxEvidenceAgeMs marks every aged evidence stale, never everything fresh", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const now = evaluationNow();
  const evaluations = evaluateEligibility(
    candidates,
    defaultRequest,
    zeroBudgetOptions(now),
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));

  // Under the default 72h budget northstar/alpha-chat is eligible
  // (see test/eligibility.test.js); under a zero budget nothing aged may be.
  assert.ok(evaluations.length > 0);
  assert.equal(
    evaluations.filter((candidate) => candidate.eligible).length,
    0,
    "zero budget must leave zero eligible routes, not mark everything fresh",
  );
  const alpha = byRoute.get("northstar/alpha-chat");
  assert.equal(alpha.eligible, false);
  assert.ok(
    alpha.reasons.includes("stale-evidence"),
    `expected stale-evidence, got: ${JSON.stringify(alpha.reasons)}`,
  );

  // Every candidate in a freshness-checked support state carries the reason;
  // `retired-chat` (unsupported) skips the evidence gate by design, so it
  // must not gain a stale-evidence reason it was never evaluated for.
  for (const evaluation of evaluations) {
    if (evaluation.supportState === "configured" || evaluation.supportState === "conformance-tested") {
      assert.ok(
        evaluation.reasons.includes("stale-evidence"),
        `${evaluation.routeId}: expected stale-evidence, got: ${JSON.stringify(evaluation.reasons)}`,
      );
    }
  }
  assert.ok(
    !byRoute.get("orbit/retired-chat").reasons.includes("stale-evidence"),
    "unsupported routes skip the evidence gate; zero must not invent reasons there",
  );
});

test("TOG-8624: zero budget still honors exact-now evidence (only this instant counts)", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const now = evaluationNow();
  const tampered = structuredClone(candidates);
  const target = tampered.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  target.evidence = { observedAt: now.toISOString() };

  const evaluations = evaluateEligibility(
    tampered,
    {
      operation: "chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
    },
    zeroBudgetOptions(now),
  );
  const alpha = evaluations.find((candidate) => candidate.routeId === "northstar/alpha-chat");

  // ageMs === 0 is not older than a zero budget (`>` not `>=`): the proof
  // that zero narrows freshness instead of disabling it.
  assert.equal(alpha.eligible, true);
  assert.deepEqual([...alpha.reasons], []);
});

test("TOG-8624: negative/NaN/Infinity maxEvidenceAgeMs throws instead of disabling the gate", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const now = evaluationNow();

  for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        evaluateEligibility(candidates, defaultRequest, {
          now,
          maxEvidenceAgeMs: budget,
          skipCatalogCheck: true,
        }),
      (error) =>
        error instanceof EligibilityRequestError &&
        /maxEvidenceAgeMs must be a non-negative number/.test(error.message),
      `budget ${String(budget)} must be rejected, never coerced`,
    );
  }
});

// ---------------------------------------------------------------------------
// CLI boundary: `select [--json]` reuses parseMaxEvidenceAgeMs, so zero flows
// through to the evaluator (exit 3, no eligible route) while a negative
// budget fails before any catalog/config IO (exit 1, exact bytes).
// ---------------------------------------------------------------------------

const EVAL_ISO = evaluationNow().toISOString();
const SELECT_INPUT = [
  "select",
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
  "--evaluation-time",
  EVAL_ISO,
];

async function runSelect(extraArgs) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/wayselect", ...extraArgs],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

test("TOG-8624: select --json with --max-evidence-age-hours 0 exits 3 with no eligible route", async () => {
  const { code, stdout, stderr } = await runSelect([...SELECT_INPUT, "--max-evidence-age-hours", "0", "--json"]);

  assert.equal(code, 3);
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.selectedRouteId, null);
  assert.equal(result.maxEvidenceAgeHours, 0);
  assert.equal(
    result.rankedCandidates.filter((candidate) => candidate.eligible).length,
    0,
    "zero budget must not select a route on the CLI either",
  );
  const alpha = result.rankedCandidates.find(
    (candidate) => candidate.routeId === "northstar/alpha-chat",
  );
  assert.ok(
    alpha.reasons.includes("stale-evidence"),
    `expected stale-evidence, got: ${JSON.stringify(alpha.reasons)}`,
  );
});

test("TOG-8624: select with --max-evidence-age-hours 0 exits 3 in human output too", async () => {
  const { code, stdout, stderr } = await runSelect([...SELECT_INPUT, "--max-evidence-age-hours", "0"]);

  assert.equal(code, 3);
  assert.equal(stderr, "");
  assert.match(stdout, /No eligible route\./);
  assert.match(stdout, /northstar\/alpha-chat — excluded \(stale-evidence\)/);
});

test("TOG-8624: select rejects --max-evidence-age-hours -1 with exit 1 and exact bytes", async () => {
  const expected = "error: --max-evidence-age-hours must be a non-negative number of hours, got: -1\n";

  const human = await runSelect([...SELECT_INPUT, "--max-evidence-age-hours", "-1"]);
  assert.equal(human.code, 1);
  assert.equal(human.stdout, "");
  assert.equal(human.stderr, expected);

  // No JSON error envelope: stdout stays byte-empty so --json consumers never
  // parse a half-written payload.
  const json = await runSelect([...SELECT_INPUT, "--max-evidence-age-hours", "-1", "--json"]);
  assert.equal(json.code, 1);
  assert.equal(json.stdout, "");
  assert.equal(json.stderr, expected);
});
