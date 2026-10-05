// TOG-7319: pre-push vs CI parity pin.
//
// bin/pre-push-check must stay a strict superset of CI: every `run:` step in
// .github/workflows/ci.yml maps to a local gate (except the documented
// `npm ci` clean-install and `npm audit` registry exclusions), every
// workflow file is parsed, and the
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
  // TOG-7281: warn-only bench measurement maps to the P9 gate. Both
  // steps keep `- run:` leading (key order is irrelevant to YAML) so the
  // extractor below sees them. The artifact upload is a `uses:` step the
  // extractor skips — the bench-job shape test below pins it instead.
  "node bin/benchmark-large-catalog | tee /large-catalog-timings.json": [
    "bin/benchmark-large-catalog",
  ],
  'echo "::warning::large-catalog benchmark over budget (warn-only; budgets enforced by test/large-catalog-benchmark.test.js)"': [
    "::warning::",
  ],
  "node bin/check-no-todo-markers": ["bin/check-no-todo-markers"],
  // TOG-6385: the `accept` job's harness step maps to the P10 gate.
  "npm run accept:all": ['"npm", ["run", "accept:all"'],
  "node scripts/e2e-staging-acceptance.mjs --out /e2e-evidence.json": [
    "scripts/e2e-staging-acceptance.mjs",
  ],
};

// Exclusions: steps with no local equivalent by design. `npm ci` uses the
// existing node_modules locally; `npm audit --audit-level=high` (TOG-7280)
// needs the npm registry, so it is CI-only and the offline local gate stays
// offline per CONTRIBUTING.md. Both exclusions are documented in the gate.
const EXCLUDED_RUNS = new Set(["npm ci", "npm audit --audit-level=high"]);

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

test("docs pin the 10-gate contract", () => {
  const doc = read("docs/pre-push-check.md");
  assert.ok(doc.includes("10 pass, 0 fail"), "doc must state the 10-gate summary");
  for (const step of ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]) {
    assert.ok(doc.includes(step), `doc must describe gate ${step}`);
  }
  assert.ok(
    read("CONTRIBUTING.md").includes("10 pass, 0 fail"),
    "CONTRIBUTING must state the 10-gate summary",
  );
  assert.ok(
    read(".github/pull_request_template.md").includes("10 pass, 0 fail"),
    "PR template must state the 10-gate summary",
  );
  assert.ok(
    read("docs/incident-runbook.md").includes("10 pass, 0 fail"),
    "incident runbook must state the 10-gate summary",
  );
  assert.ok(
    read(".github/ISSUE_TEMPLATE/feature_request.yml").includes("10 pass, 0 fail"),
    "feature-request template must state the 10-gate summary",
  );
});

test("P9 mirrors the warn-only bench CI job", () => {
  const gate = read("bin/pre-push-check");
  assert.ok(gate.includes("bin/benchmark-large-catalog"), "P9 must run the bench");
  assert.ok(
    gate.includes("::warning::"),
    "P9 must emit the same warn-only annotation CI emits",
  );
});

test("bench CI job stays warn-only with a timings artifact (TOG-7281)", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.ok(ci.includes("large-catalog-bench"), "bench job must exist");
  assert.ok(ci.includes("continue-on-error: true"), "bench run must not red the job");
  // Pinned to the upload-artifact major in .github/workflows/ci.yml
  // (v7 since TOG-8344 / PR #235).
  assert.ok(
    ci.includes("actions/upload-artifact@v7"),
    "bench job must upload the timings artifact",
  );
  assert.ok(
    ci.includes("large-catalog-timings"),
    "artifact must carry the timings name",
  );
  assert.ok(ci.includes("if: always()"), "artifact upload must run on bench failure too");
  assert.ok(
    ci.includes("if-no-files-found: warn"),
    "missing timings must warn, never fail the job",
  );
  // Pipefail: `bench | tee` must propagate a bench exit 1, else the
  // warning step never fires. `shell: bash` runs `bash -eo pipefail`;
  // the default `bash -e` would report tee's exit 0.
  const benchBlock = ci.slice(
    ci.indexOf("  large-catalog-bench:"),
    ci.indexOf("  marker-gate:"),
  );
  assert.ok(benchBlock.includes("shell: bash"), "bench step needs pipefail shell");
});
