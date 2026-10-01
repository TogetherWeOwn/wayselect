// TOG-7280: npm audit gate pin.
//
// CI fails on a new high/critical advisory via `npm audit
// --audit-level=high` in the `audit` job. The audit step needs the npm
// registry, so it is CI-only by design and excluded from the offline local
// gate (see bin/pre-push-check + test/pre-push-parity.test.js EXCLUDED_RUNS).
// Static source assertions only: no subprocess, no network, so this stays
// offline and fast.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, repoRoot), "utf8");

function auditJobBlock() {
  const ci = read(".github/workflows/ci.yml");
  const start = ci.indexOf("  audit:");
  assert.ok(start !== -1, "ci.yml must contain an `audit` job");
  // Slice from the audit job header to the next top-level job header.
  const rest = ci.slice(start);
  const nextJob = rest.slice(1).search(/\n  [a-z-]+:/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

test("audit job runs npm audit at high level", () => {
  const job = auditJobBlock();
  assert.ok(
    job.includes("npm audit --audit-level=high"),
    "audit job must run `npm audit --audit-level=high`",
  );
});

test("audit job fails red (never warn-only)", () => {
  const job = auditJobBlock();
  assert.ok(
    !job.includes("continue-on-error"),
    "audit job must not carry continue-on-error — a new advisory reds CI",
  );
});

test("audit step stays in the parity exclusion set", () => {
  const parity = read("test/pre-push-parity.test.js");
  assert.ok(
    parity.includes('"npm audit --audit-level=high"'),
    "parity pin must account for the audit step (excluded: registry-only)",
  );
});

test("audit exclusion is documented in the local gate and docs", () => {
  const gate = read("bin/pre-push-check");
  assert.ok(
    gate.includes("npm audit --audit-level=high"),
    "gate must document the audit exclusion",
  );
  assert.ok(
    gate.includes("Intentionally not run locally"),
    "exclusion must carry its rationale",
  );
  assert.ok(
    read("docs/pre-push-check.md").includes("npm audit --audit-level=high"),
    "docs must document the audit exclusion",
  );
  assert.ok(
    read("CONTRIBUTING.md").includes("npm audit --audit-level=high"),
    "CONTRIBUTING must name the audit gate",
  );
});
