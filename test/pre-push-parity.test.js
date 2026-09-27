// TOG-7319: pre-push vs CI parity pin.
//
// bin/pre-push-check must stay a strict superset of CI: every `run:` step in
// .github/workflows/ci.yml maps to a local gate (except the documented
// `npm ci` clean-install exclusion), every workflow file is parsed, and the
// marker gate stays a single-sourced exact CI step — never a duplicated word
// list inside the pre-push script. Static source assertions only: no
// subprocess, so this stays offline and fast. The full gate itself is
// exercised by running `npm run pre-push`.
//
// Marker-safety: this file never spells a tracked marker word literally
// (see bin/check-no-todo-markers for why); references use fragments.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, repoRoot), "utf8");

// CI `run:` step (normalized) -> substrings that must appear in the
// pre-push source as the mirroring local gate. When CI gains a step, this
// map must gain a row — that is the parity contract.
const RUN_TO_GATE = {
  "node bin/check-node-engines": ["bin/check-node-engines"],
  "npm test": ['"npm", ["test"'],
  "npm run smoke": ['"npm", ["run", "smoke"'],
  "npm run check:search-index": ["check:search-index"],
  "node bin/check-no-todo-markers": ["bin/check-no-todo-markers"],
  "node scripts/e2e-staging-acceptance.mjs --out /e2e-evidence.json": [
    "scripts/e2e-staging-acceptance.mjs",
  ],
};

// The one exclusion: CI's clean-install step has no local equivalent by
// design (the gate uses the existing node_modules).
const EXCLUDED_RUNS = new Set(["npm ci"]);

function ciRunSteps() {
  const ci = read(".github/workflows/ci.yml");
  return [...ci.matchAll(/-\s*run:\s*(.+)/g)].map((m) =>
    m[1]
      .trim()
      .replace(/\s*\$\{\{.*?\}\}\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

test("ci run steps match the pinned parity map", () => {
  const steps = ciRunSteps();
  assert.ok(steps.length > 0, "expected at least one run: step in ci.yml");
  const mapped = new Set([...Object.keys(RUN_TO_GATE), ...EXCLUDED_RUNS]);
  assert.deepEqual(
    new Set(steps),
    mapped,
    "ci.yml run steps changed — update RUN_TO_GATE (and bin/pre-push-check) to match",
  );
});

test("every non-excluded CI run step has a local pre-push gate", () => {
  const gate = read("bin/pre-push-check");
  for (const step of ciRunSteps()) {
    if (EXCLUDED_RUNS.has(step)) continue;
    for (const token of RUN_TO_GATE[step]) {
      assert.ok(
        gate.includes(token),
        `CI step "${step}" has no local gate (missing ${token} in bin/pre-push-check)`,
      );
    }
  }
});

test("the npm ci exclusion is documented in the gate source", () => {
  const gate = read("bin/pre-push-check");
  assert.ok(gate.includes("npm ci"), "exclusion must name the excluded step");
  assert.ok(
    gate.includes("Intentionally not run locally"),
    "exclusion must carry its rationale",
  );
});

test("P2 covers every shipped script tree including .mjs", () => {
  const gate = read("bin/pre-push-check");
  for (const dir of ["src", "test", "web", "support", "scripts", "evals"]) {
    assert.ok(gate.includes(`"${dir}"`), `P2 must scan ${dir}/`);
  }
  assert.ok(gate.includes('".mjs"'), "P2 must cover .mjs entries (scripts/*.mjs)");
  // The two CI-adjacent scripts that pre-date the parity fix must exist and
  // therefore be inside the scanned trees.
  read("scripts/e2e-staging-acceptance.mjs");
  read("scripts/generate-large-catalog.mjs");
});

test("P4 scans the workflows directory instead of one hardcoded file", () => {
  const gate = read("bin/pre-push-check");
  assert.ok(
    gate.includes("readdirSync(workflowsDir)"),
    "P4 must enumerate .github/workflows/ instead of hardcoding ci.yml",
  );
  assert.ok(
    !gate.includes('const ciRel = ".github/workflows/ci.yml"'),
    "P4 must not regress to the single-file check",
  );
  const workflows = readdirSync(new URL(".github/workflows/", repoRoot)).sort();
  assert.ok(workflows.includes("ci.yml"), "ci.yml must exist");
  assert.ok(workflows.includes("acceptance.yml"), "acceptance.yml must exist");
});

test("marker gate stays single-sourced (no duplicated word list)", () => {
  const gate = read("bin/pre-push-check");
  assert.ok(
    gate.includes("bin/check-no-todo-markers"),
    "pre-push must invoke the exact CI gate script",
  );
  assert.ok(
    !gate.includes("MARKER_WORDS") && !gate.includes("MARKER_RE"),
    "pre-push must not duplicate the gate word list (single source of truth)",
  );
});

test("acceptance workflow local steps are mirrored or explicitly excluded", () => {
  const gate = read("bin/pre-push-check");
  const acceptance = read(".github/workflows/acceptance.yml");
  assert.ok(acceptance.includes("scripts/acceptance.sh"), "acceptance workflow shape pin");
  // Demo + test steps run locally; the clean-clone mode is excluded by design.
  assert.ok(gate.includes('"demo"'), "P8 must run the demo step locally");
  assert.ok(gate.includes("acceptance.sh"), "gate must document the clone-mode exclusion");
});

test("docs pin the 8-gate contract", () => {
  const doc = read("docs/pre-push-check.md");
  assert.ok(doc.includes("8 pass, 0 fail"), "doc must state the 8-gate summary");
  for (const step of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]) {
    assert.ok(doc.includes(step), `doc must describe gate ${step}`);
  }
  assert.ok(
    read("CONTRIBUTING.md").includes("8 pass, 0 fail"),
    "CONTRIBUTING must state the 8-gate summary",
  );
  assert.ok(
    read(".github/pull_request_template.md").includes("8 pass, 0 fail"),
    "PR template must state the 8-gate summary",
  );
});
