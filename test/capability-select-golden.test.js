// TOG-5860 (S4): QA golden-output harness for capability-aware dry-run
// select, acceptance A1–A7 of docs/acceptance-spec-capability-select.md.
//
// What this pins (CLI end to end, fixture-only, no network):
//   A1  typed-requirement select exits 0; the winner satisfies every
//       requirement; rankedCandidates present with per-candidate reasons.
//   A2  impossible thresholds exit 3 with status no-eligible-route and every
//       candidate naming its excluding requirement.
//   A3  a model with a missing capability field is excluded with
//       missing-capability:<field> (the implemented vocabulary for the
//       spec's unknown-capability:<field>), never selected.
//   A4  a stale catalog refuses the decision: exit 3, every candidate
//       carries exactly stale-catalog (no eligibility detail leaks).
//   A5  a tie fixture picks deterministically; consecutive runs are
//       byte-identical (also under a disagreeing locale).
//   A6  non-configured / non-conformance-tested entries are never selected,
//       even when cheapest.
//   A7  select --help lists every R1 flag; README shows an end-to-end
//       select example.
//
// Fixtures are small and newly authored (synthetic:// source, computed
// snapshot hash — never a redistributed catalog snapshot), written to a temp
// dir so npm test picks this file up in CI via the existing test/*.test.js
// glob. Fixed clocks (snapshot + 2h evaluation, pinned fetchedAt) keep the
// goldens deterministic; the stale case offsets past the 24h catalog window
// on purpose. Node stdlib only.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { computeCatalogSnapshotHash, validateCliJson } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const SNAPSHOT_ISO = "2026-09-26T14:00:00.000Z";
const EVAL_ISO = "2026-09-26T16:00:00.000Z";
const STALE_EVAL_ISO = "2026-09-27T15:00:01.000Z";

const R1_FLAGS = [
  "--input-modalities",
  "--output-modalities",
  "--min-context-window",
  "--max-output-tokens",
  "--require-tools",
  "--require-structured-output",
  "--require-reasoning",
];

function textModel(id, overrides = {}) {
  return {
    id,
    name: id,
    reasoning: false,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    context_window: 200000,
    max_output_tokens: 8192,
    cost: { input: 1, output: 2 },
    ...overrides,
  };
}

// Small newly-authored catalog: a cheap winner, a pricier runner-up, a model
// with unknown tool data (A3), a narrow-context model, and the cheapest model
// parked in an unsupported state (A6 — price must not rescue it).
function capabilityCatalog() {
  return {
    qa: {
      id: "qa",
      name: "S4 Synthetic Provider",
      models: {
        "winner-chat": textModel("winner-chat", { cost: { input: 1, output: 2 } }),
        "runner-chat": textModel("runner-chat", { cost: { input: 2, output: 4 } }),
        "unknown-tools": {
          id: "unknown-tools",
          name: "unknown-tools",
          reasoning: false,
          modalities: { input: ["text"], output: ["text"] },
          context_window: 200000,
          cost: { input: 0.25, output: 0.5 },
        },
        "narrow-chat": textModel("narrow-chat", {
          context_window: 64000,
          cost: { input: 0.5, output: 0.5 },
        }),
        "retired-chat": textModel("retired-chat", {
          cost: { input: 0.1, output: 0.1 },
        }),
      },
    },
  };
}

function configured(routeId) {
  return {
    routeId,
    supportState: "configured",
    operations: ["chat"],
    evidence: { observedAt: SNAPSHOT_ISO },
  };
}

async function writeCapabilityFixture(dir) {
  const catalog = capabilityCatalog();
  await writeFile(
    join(dir, "s4-catalog.json"),
    JSON.stringify({
      catalog,
      provenance: {
        source: "synthetic://wayselect/capability-select-s4",
        snapshotTimestamp: SNAPSHOT_ISO,
        snapshotHash: computeCatalogSnapshotHash(catalog),
        fetchedAt: SNAPSHOT_ISO,
      },
    }),
  );
  await writeFile(
    join(dir, "s4-configuration.json"),
    JSON.stringify({
      candidates: [
        configured("qa/winner-chat"),
        configured("qa/runner-chat"),
        configured("qa/unknown-tools"),
        configured("qa/narrow-chat"),
        {
          routeId: "qa/retired-chat",
          supportState: "unsupported",
          operations: [],
          evidence: { observedAt: SNAPSHOT_ISO },
        },
      ],
    }),
  );
  return [join(dir, "s4-catalog.json"), join(dir, "s4-configuration.json")];
}

// Minimal tie catalog for A5: two fully-qualifying entries at equal rates.
async function writeTieFixture(dir) {
  const catalog = {
    qt: {
      id: "qt",
      name: "S4 Tie Provider",
      models: {
        "a-chat": textModel("a-chat"),
        "m-chat": textModel("m-chat"),
      },
    },
  };
  await writeFile(
    join(dir, "tie-catalog.json"),
    JSON.stringify({
      catalog,
      provenance: {
        source: "synthetic://wayselect/capability-select-s4-tie",
        snapshotTimestamp: SNAPSHOT_ISO,
        snapshotHash: computeCatalogSnapshotHash(catalog),
        fetchedAt: SNAPSHOT_ISO,
      },
    }),
  );
  await writeFile(
    join(dir, "tie-configuration.json"),
    JSON.stringify({ candidates: [configured("qt/a-chat"), configured("qt/m-chat")] }),
  );
  return [join(dir, "tie-catalog.json"), join(dir, "tie-configuration.json")];
}

function typedArgs(catalogPath, configurationPath, evaluationTime, extra = []) {
  return [
    "select",
    "--catalog",
    catalogPath,
    "--configuration",
    configurationPath,
    "--operation",
    "chat",
    "--allow",
    "qa",
    "--input-modalities",
    "text",
    "--output-modalities",
    "text",
    "--min-context-window",
    "128000",
    "--require-tools",
    "--evaluation-time",
    evaluationTime,
    ...extra,
  ];
}

async function runSelect(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/wayselect", ...args],
      { cwd: repoRoot, env },
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

function byRoute(candidates) {
  return new Map(candidates.map((candidate) => [candidate.routeId, candidate]));
}

async function freshFixture() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-capability-s4-"));
  const [catalog, configuration] = await writeCapabilityFixture(dir);
  return { catalog, configuration };
}

test("A1: typed-requirement select exits 0 with a satisfying winner (JSON)", async () => {
  const { catalog, configuration } = await freshFixture();
  const run = await runSelect(
    typedArgs(catalog, configuration, EVAL_ISO, ["--json"]),
    process.env,
  );
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(validateCliJson(payload), { ok: true });
  assert.equal(payload.status, "selected");
  assert.equal(payload.selectedRouteId, "qa/winner-chat");

  // Winner satisfies every requirement: eligible with no exclusion reasons,
  // and the echoed request carries the exact typed requirements.
  const routes = byRoute(payload.rankedCandidates);
  assert.equal(routes.get("qa/winner-chat")?.eligible, true);
  assert.deepEqual(routes.get("qa/winner-chat")?.reasons, []);
  assert.deepEqual(payload.request.requirements.inputModalities, ["text"]);
  assert.deepEqual(payload.request.requirements.outputModalities, ["text"]);
  assert.equal(payload.request.requirements.minContextWindow, 128000);
  assert.equal(payload.request.requirements.toolCalling, true);

  // rankedCandidates present; every excluded candidate names its reasons.
  assert.ok(payload.rankedCandidates.length >= 5);
  const excluded = payload.rankedCandidates.filter((candidate) => !candidate.eligible);
  assert.ok(excluded.length >= 3);
  for (const candidate of excluded) {
    assert.ok(candidate.reasons.length > 0, `${candidate.routeId} names a reason`);
  }
});

test("A1: human output selects the winner and names exclusions", async () => {
  const { catalog, configuration } = await freshFixture();
  const run = await runSelect(typedArgs(catalog, configuration, EVAL_ISO), process.env);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Selected route: qa\/winner-chat/);
  assert.match(run.stdout, /qa\/unknown-tools — excluded \([^)]*missing-capability:toolUse[^)]*\)/);
  assert.match(run.stdout, /qa\/retired-chat — excluded \([^)]*support-state:unsupported[^)]*\)/);
});

test("A2: impossible context threshold exits 3 with every excluder named (JSON)", async () => {
  const { catalog, configuration } = await freshFixture();
  const args = typedArgs(catalog, configuration, EVAL_ISO, ["--json"]).map((token) =>
    token === "128000" ? "10000000" : token,
  );
  const run = await runSelect(args, process.env);
  assert.equal(run.code, 3);
  const payload = JSON.parse(run.stdout);
  assert.deepEqual(validateCliJson(payload), { ok: true });
  assert.equal(payload.status, "no-eligible-route");
  assert.equal(payload.selectedRouteId, null);
  assert.ok(payload.rankedCandidates.length > 0);
  for (const candidate of payload.rankedCandidates) {
    assert.equal(candidate.eligible, false);
    assert.ok(
      candidate.reasons.includes("insufficient-context-window") ||
        candidate.reasons.includes("missing-capability:contextWindow"),
      `${candidate.routeId} names the excluding requirement: ${candidate.reasons.join(", ")}`,
    );
  }
});

test("A2: human output is a no-eligible-route verdict naming the requirement", async () => {
  const { catalog, configuration } = await freshFixture();
  const args = typedArgs(catalog, configuration, EVAL_ISO).map((token) =>
    token === "128000" ? "10000000" : token,
  );
  const run = await runSelect(args, process.env);
  assert.equal(run.code, 3);
  assert.match(run.stdout, /No eligible route\./);
  assert.match(run.stdout, /insufficient-context-window/);
});

test("A3: missing capability data fails closed, never selected", async () => {
  const { catalog, configuration } = await freshFixture();
  const run = await runSelect(
    typedArgs(catalog, configuration, EVAL_ISO, ["--json"]),
    process.env,
  );
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout);
  const routes = byRoute(payload.rankedCandidates);
  assert.equal(routes.get("qa/unknown-tools")?.eligible, false);
  assert.ok(routes.get("qa/unknown-tools")?.reasons.includes("missing-capability:toolUse"));
  assert.notEqual(payload.selectedRouteId, "qa/unknown-tools");
});

test("A4: stale catalog refuses the decision before eligibility detail", async () => {
  const { catalog, configuration } = await freshFixture();
  const run = await runSelect(
    typedArgs(catalog, configuration, STALE_EVAL_ISO, ["--json"]),
    process.env,
  );
  assert.equal(run.code, 3);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.status, "no-eligible-route");
  assert.equal(payload.selectedRouteId, null);
  assert.ok(payload.rankedCandidates.length > 0);
  for (const candidate of payload.rankedCandidates) {
    assert.equal(candidate.eligible, false);
    assert.deepEqual(
      candidate.reasons,
      ["stale-catalog"],
      `${candidate.routeId} carries only the catalog refusal`,
    );
  }
});

test("A5: tie fixture is deterministic and byte-identical across runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-capability-s4-tie-"));
  const [catalog, configuration] = await writeTieFixture(dir);
  const args = [
    "select",
    "--catalog",
    catalog,
    "--configuration",
    configuration,
    "--operation",
    "chat",
    "--allow",
    "qt",
    "--input-modalities",
    "text",
    "--output-modalities",
    "text",
    "--min-context-window",
    "128000",
    "--require-tools",
    "--evaluation-time",
    EVAL_ISO,
    "--json",
  ];
  const first = await runSelect(args, process.env);
  assert.equal(first.code, 0);
  assert.equal(first.stderr, "");
  const payload = JSON.parse(first.stdout);
  assert.equal(payload.selectedRouteId, "qt/a-chat");
  assert.deepEqual(
    payload.rankedCandidates.map((candidate) => candidate.routeId),
    ["qt/a-chat", "qt/m-chat"],
  );

  const second = await runSelect(args, process.env);
  assert.equal(second.stdout, first.stdout, "consecutive runs are byte-identical");

  const otherLocale = await runSelect(args, {
    ...process.env,
    LC_ALL: "lt_LT.UTF-8",
    LANG: "lt_LT.UTF-8",
  });
  assert.equal(otherLocale.stdout, first.stdout, "bytes hold under a disagreeing locale");
});

test("A6: unsupported entries are never selected, even when cheapest", async () => {
  const { catalog, configuration } = await freshFixture();
  const run = await runSelect(
    typedArgs(catalog, configuration, EVAL_ISO, ["--json"]),
    process.env,
  );
  assert.equal(run.code, 0);
  const payload = JSON.parse(run.stdout);
  assert.notEqual(payload.selectedRouteId, "qa/retired-chat");
  const routes = byRoute(payload.rankedCandidates);
  assert.equal(routes.get("qa/retired-chat")?.eligible, false);
  assert.ok(routes.get("qa/retired-chat")?.reasons.includes("support-state:unsupported"));
});

test("A7: select --help lists every R1 flag; README shows an end-to-end example", async () => {
  const help = await runSelect(["select", "--help"], process.env);
  assert.equal(help.code, 0);
  for (const flag of R1_FLAGS) {
    assert.ok(help.stdout.includes(flag), `--help lists ${flag}`);
  }
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /```sh[\s\S]*?bin\/wayselect select[\s\S]*?```/,
    "README shows one end-to-end select example",
  );
});
