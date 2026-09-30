// TOG-5858 (S2): deterministic ranking + tie-break per spec R5.
//
// All else equal, lower list price wins, then UTF-16 code-unit route-ID
// order (src/routeIds.js — never localeCompare; see TOG-5644). Identical
// inputs produce byte-identical outputs across runs: no timestamp, locale,
// or process-order leakage.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  compareRouteIds,
  computeCatalogSnapshotHash,
  selectRoute,
} from "../src/index.js";
import { evaluationOptions } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const REQUEST = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["p"],
});

// Evidence sits at the tie-fixture snapshot (2h before the evaluation
// clock), so the evidence gate passes and the tests exercise ranking only.
function inlineCandidate(routeId, rates) {
  const [, modelId] = routeId.split("/");
  return {
    routeId,
    providerId: "p",
    modelId,
    supportState: "configured",
    catalogOperations: ["chat"],
    configuredOperations: ["chat"],
    capabilities: { toolUse: true },
    evidence: { observedAt: new Date(evaluationOptions.now.getTime() - 2 * 60 * 60 * 1000).toISOString() },
    ...(rates === undefined ? {} : { rates }),
  };
}

// NOTE: selectRoute returns candidates in code-unit route-ID order (output
// stability); rank order surfaces via `selected` at library level and via
// `rankedCandidates` in the CLI machine JSON (pinned end to end below). For
// equal-rate ties the two orders coincide, so eligibleOrder is the rank
// order there and only there.
function eligibleOrder(result) {
  return result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.routeId);
}

test("compareRouteIds uses code-unit order, not locale order", () => {
  // Uppercase sorts before lowercase by code unit; several ICU locales
  // (including lt) collate the opposite way.
  assert.equal(compareRouteIds("p/B-chat", "p/a-chat"), -1);
  assert.equal(compareRouteIds("p/a-chat", "p/B-chat"), 1);
  assert.equal(compareRouteIds("p/k-chat", "p/y-chat"), -1);
  assert.equal(compareRouteIds("p/y-chat", "p/k-chat"), 1);
  assert.equal(compareRouteIds("p/same", "p/same"), 0);
});

test("equal-rate ties break by code-unit route id, independent of input order", () => {
  const rate = { inputPerMillion: 1, outputPerMillion: 2 };
  const candidates = [
    inlineCandidate("p/y-chat", rate),
    inlineCandidate("p/a-chat", rate),
    inlineCandidate("p/B-chat", rate),
    inlineCandidate("p/k-chat", rate),
  ];
  const forward = selectRoute(candidates, REQUEST, evaluationOptions);
  const reverse = selectRoute([...candidates].reverse(), REQUEST, evaluationOptions);

  assert.equal(forward.status, "selected");
  assert.equal(forward.selected.routeId, "p/B-chat");
  assert.deepEqual(eligibleOrder(forward), [
    "p/B-chat",
    "p/a-chat",
    "p/k-chat",
    "p/y-chat",
  ]);
  assert.deepEqual(reverse, forward);
  assert.equal(
    JSON.stringify(forward),
    JSON.stringify(reverse),
    "identical inputs serialize to byte-identical output",
  );
});

test("lower list price wins regardless of route id", () => {
  const result = selectRoute(
    [
      inlineCandidate("p/B-chat", { inputPerMillion: 5, outputPerMillion: 5 }),
      inlineCandidate("p/y-chat", { inputPerMillion: 0.25, outputPerMillion: 0.5 }),
    ],
    REQUEST,
    evaluationOptions,
  );

  assert.equal(result.status, "selected");
  assert.equal(result.selected.routeId, "p/y-chat");
});

test("entries without rate data lose to rated entries, never win ties", () => {
  const candidates = [
    inlineCandidate("p/y-chat"),
    inlineCandidate("p/k-chat", { inputPerMillion: 1, outputPerMillion: 1 }),
    inlineCandidate("p/a-chat"),
  ];
  const result = selectRoute(candidates, REQUEST, evaluationOptions);
  const reverse = selectRoute([...candidates].reverse(), REQUEST, evaluationOptions);

  assert.equal(result.status, "selected");
  assert.equal(result.selected.routeId, "p/k-chat");
  assert.ok(
    result.candidates.every((candidate) => candidate.eligible),
    "unrated entries stay eligible — they rank last, they are not excluded",
  );
  assert.deepEqual(reverse, result);
  assert.equal(JSON.stringify(reverse), JSON.stringify(result));
});

// ---- CLI byte-identical output (spec A5) ----

// Fixed clocks so consecutive runs are comparable byte for byte: the tie
// snapshot sits 2h before the evaluation clock (inside the 72h evidence and
// 24h catalog windows), and the fixture pins fetchedAt (the shared default
// stamps wall-clock there for live ingestion paths).
const SNAPSHOT_ISO = "2026-09-26T14:00:00.000Z";
const EVAL_ISO = "2026-09-26T16:00:00.000Z";

function tieModel(id) {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 1, output: 2 },
  };
}

async function writeTieFixture(dir) {
  const catalog = {
    p: {
      id: "p",
      name: "Tie Synthetic Provider",
      models: { "k-chat": tieModel("k-chat"), "y-chat": tieModel("y-chat") },
    },
  };
  await writeFile(
    join(dir, "tie-catalog.json"),
    JSON.stringify({
      catalog,
      provenance: {
        source: "synthetic://wayselect/tie-r5",
        snapshotTimestamp: SNAPSHOT_ISO,
        snapshotHash: computeCatalogSnapshotHash(catalog),
        fetchedAt: SNAPSHOT_ISO,
      },
    }),
  );
  const configured = (routeId) => ({
    routeId,
    supportState: "configured",
    operations: ["chat"],
    evidence: { observedAt: SNAPSHOT_ISO },
  });
  await writeFile(
    join(dir, "tie-configuration.json"),
    JSON.stringify({ candidates: [configured("p/k-chat"), configured("p/y-chat")] }),
  );
  return [
    "select",
    "--catalog",
    join(dir, "tie-catalog.json"),
    "--configuration",
    join(dir, "tie-configuration.json"),
    "--operation",
    "chat",
    "--require",
    "toolUse",
    "--allow",
    "p",
    "--evaluation-time",
    EVAL_ISO,
    "--json",
  ];
}

async function runSelect(args, env) {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["bin/wayselect", ...args], {
    cwd: repoRoot,
    env,
  });
  assert.equal(stderr, "");
  return stdout;
}

test("tie fixture: winner deterministic, consecutive runs byte-identical across locales", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-tie-r5-"));
  const args = await writeTieFixture(dir);

  const first = await runSelect(args, process.env);
  const result = JSON.parse(first);
  assert.equal(result.status, "selected");
  // Code-unit order picks k-chat; lt_LT collation would pick y-chat under
  // the old localeCompare tie-break (TOG-5644 repro).
  assert.equal(result.selectedRouteId, "p/k-chat");
  assert.deepEqual(
    result.rankedCandidates.map((candidate) => candidate.routeId),
    ["p/k-chat", "p/y-chat"],
  );

  const second = await runSelect(args, process.env);
  assert.equal(second, first, "two consecutive runs produce identical output bytes");

  const otherLocale = await runSelect(args, {
    ...process.env,
    LC_ALL: "lt_LT.UTF-8",
    LANG: "lt_LT.UTF-8",
  });
  assert.equal(
    otherLocale,
    first,
    "output bytes are identical under a locale whose collation disagrees",
  );
});
