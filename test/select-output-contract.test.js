// S3 (R6–R8): typed-requirement output and executable README example.
// Exit 1/2 and help are covered in cli.test.js; v1 JSON snapshots in
// cli-json-contract.test.js. Fixtures here are synthetic and offline.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { computeCatalogSnapshotHash } from "../src/index.js";
import { validateCliJson } from "../src/validate-cli-json.js";
import { evaluationNow } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Refresh-proof clock for the pinned fixtures: snapshot + 2h keeps the
// catalog fresh and the evidence inside its 72h window.
const EVAL_ISO = evaluationNow().toISOString();

// Fixed clocks for the authored fixture below: the temp catalog carries its
// own provenance, so fixed clocks are refresh-proof by construction (same
// pattern as test/ranking.test.js).
const SNAPSHOT_ISO = "2026-09-26T14:00:00.000Z";
const FIXTURE_EVAL_ISO = "2026-09-26T16:00:00.000Z";

async function runSelect(args, { expectFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/wayselect", "select", ...args],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (!expectFailure) {
      throw error;
    }
    return {
      code: error.code,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

async function writeTempJson(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

// A1 shape (exit 0): the full typed-requirement set minus the context-window
// threshold the pinned fixture cannot satisfy (see the next test). The winner
// must satisfy every requirement; the trace must be present in --json.
test("TOG-5859: full typed-requirement run selects a satisfying route (exit 0)", async () => {
  const args = [
    "--operation",
    "chat",
    "--allow",
    "northstar,orbit",
    "--input-modalities",
    "text",
    "--output-modalities",
    "text",
    "--require-tools",
    "--evaluation-time",
    EVAL_ISO,
    "--json",
  ];
  const { code, stdout, stderr } = await runSelect(args);

  assert.equal(code, 0);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "selected");
  assert.equal(payload.selectedRouteId, "northstar/alpha-chat");
  assert.deepEqual(payload.request.requirements, {
    inputModalities: ["text"],
    outputModalities: ["text"],
    minContextWindow: null,
    maxOutputTokens: null,
    toolCalling: true,
    structuredOutput: false,
    reasoning: false,
  });
  assert.ok(payload.rankedCandidates.length > 0);
  for (const candidate of payload.rankedCandidates) {
    if (candidate.eligible) {
      assert.deepEqual(candidate.reasons, [], `${candidate.routeId} is eligible but carries reasons`);
    } else {
      assert.ok(
        candidate.reasons.length > 0,
        `${candidate.routeId} is excluded but names no requirement`,
      );
    }
  }
  const winner = payload.rankedCandidates.find(
    (candidate) => candidate.routeId === payload.selectedRouteId,
  );
  assert.equal(winner.eligible, true);
});

// R6 machine side: the v1 contract accepts a fully-populated typed
// `requirements` object (existing snapshots only pin `requirements: {}`).
test("TOG-5859: typed-requirement --json validates against the v1 schema", async () => {
  const { stdout } = await runSelect([
    "--operation",
    "chat",
    "--allow",
    "northstar,orbit",
    "--input-modalities",
    "text",
    "--output-modalities",
    "text",
    "--require-tools",
    "--evaluation-time",
    EVAL_ISO,
    "--json",
  ]);
  assert.deepEqual(validateCliJson(JSON.parse(stdout)), { ok: true });
});

function contractModel(id, contextWindow) {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    tool_call: true,
    structured_output: false,
    modalities: { input: ["text"], output: ["text"] },
    context_window: contextWindow,
    cost: { input: 1, output: 2 },
  };
}

// A1 threshold path (exit 0): small newly-authored fixture where one entry
// clears `--min-context-window 128000` and the other does not. Proves the
// threshold selects when limit data exists.
test("TOG-5859: context-window threshold selects when fixture data satisfies it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-s3-contract-"));
  try {
    const catalog = {
      acme: {
        id: "acme",
        name: "Acme Synthetic",
        models: {
          "big-chat": contractModel("big-chat", 200000),
          "small-chat": contractModel("small-chat", 8000),
        },
      },
    };
    const catalogPath = await writeTempJson(dir, "catalog.json", {
      catalog,
      provenance: {
        source: "synthetic://wayselect/s3-contract",
        snapshotTimestamp: SNAPSHOT_ISO,
        snapshotHash: computeCatalogSnapshotHash(catalog),
        fetchedAt: SNAPSHOT_ISO,
      },
    });
    const configured = (routeId) => ({
      routeId,
      supportState: "configured",
      operations: ["chat"],
      evidence: { observedAt: SNAPSHOT_ISO },
    });
    const configurationPath = await writeTempJson(dir, "configuration.json", {
      candidates: [configured("acme/big-chat"), configured("acme/small-chat")],
    });

    const { code, stdout, stderr } = await runSelect([
      "--catalog",
      catalogPath,
      "--configuration",
      configurationPath,
      "--operation",
      "chat",
      "--allow",
      "acme",
      "--input-modalities",
      "text",
      "--output-modalities",
      "text",
      "--min-context-window",
      "128000",
      "--require-tools",
      "--evaluation-time",
      FIXTURE_EVAL_ISO,
      "--json",
    ]);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    const payload = JSON.parse(stdout);
    assert.equal(payload.status, "selected");
    assert.equal(payload.selectedRouteId, "acme/big-chat");
    assert.deepEqual(validateCliJson(payload), { ok: true });
    const byId = Object.fromEntries(
      payload.rankedCandidates.map((candidate) => [candidate.routeId, candidate]),
    );
    assert.equal(byId["acme/big-chat"].eligible, true);
    assert.equal(byId["acme/small-chat"].eligible, false);
    assert.ok(
      byId["acme/small-chat"].reasons.includes("insufficient-context-window"),
      `small-chat must name the unmet threshold, got: ${byId["acme/small-chat"].reasons}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A1 literal vs the pinned fixture: no checked-in entry carries
// `context_window`, so the threshold fails closed (exit 3) instead of
// selecting. This documents the fixture constraint; the path above proves
// the threshold itself works.
test("TOG-5859: context-window threshold fails closed on unknown fixture limits", async () => {
  const { code, stdout, stderr } = await runSelect(
    [
      "--operation",
      "chat",
      "--allow",
      "northstar,orbit",
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
    ],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "no-eligible-route");
  assert.equal(payload.selectedRouteId, null);
  assert.ok(payload.rankedCandidates.length > 0);
  for (const candidate of payload.rankedCandidates) {
    assert.equal(candidate.eligible, false);
    assert.ok(
      candidate.reasons.includes("missing-capability:contextWindow"),
      `${candidate.routeId} must fail closed on unknown limits`,
    );
  }
});

// R8: the README end-to-end example (A7) must stay executable — the exact
// command runs exit 0 against the pinned fixtures, and the documented output
// block matches live output with timestamps normalized (same clock-substitution
// pattern as test/cli-docs-examples.test.js).
test("TOG-5859: README end-to-end select example executes and matches", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const commandBlock = readme.match(
    /```sh\n(node bin\/wayselect select --operation chat --allow northstar,orbit \\\n(?:.*\n)*?.*?--evaluation-time \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\n```/,
  );
  assert.ok(commandBlock, "README must carry the end-to-end select command");
  // Slice off `node bin/wayselect select` — runSelect prepends the
  // subcommand itself.
  const argv = commandBlock[1]
    .replace(/\\\n/g, " ")
    .split(/\s+/)
    .slice(3)
    .map((token, index, tokens) =>
      tokens[index - 1] === "--evaluation-time" ? EVAL_ISO : token,
    );
  const { code, stdout, stderr } = await runSelect(argv);
  assert.equal(code, 0);
  assert.equal(stderr, "");

  const outputBlock = readme.match(
    /```text\ndry-run select — dry-run \/ synthetic estimate([\s\S]*?)\n```/,
  );
  assert.ok(outputBlock, "README must carry the end-to-end select output");
  const normalize = (value) =>
    value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");
  assert.equal(
    normalize(stdout.trim()),
    normalize(`dry-run select — dry-run / synthetic estimate${outputBlock[1]}`),
    "README example output drifted from live CLI output",
  );
});

// A2 / R7: unsatisfiable requirements are a first-class outcome — exit 3,
// machine-readable no-eligible-route with every candidate naming its
// excluding requirement, and human output naming one per candidate too.
test("TOG-5859: unsatisfiable requirements exit 3 with per-candidate reasons on both outputs", async () => {
  const baseArgs = [
    "--operation",
    "chat",
    "--allow",
    "northstar",
    "--input-modalities",
    "text",
    "--output-modalities",
    "text",
    "--min-context-window",
    "10000000",
    "--require-tools",
    "--evaluation-time",
    EVAL_ISO,
  ];

  const jsonRun = await runSelect([...baseArgs, "--json"], { expectFailure: true });
  assert.equal(jsonRun.code, 3);
  assert.equal(jsonRun.stderr, "");
  const payload = JSON.parse(jsonRun.stdout);
  assert.equal(payload.status, "no-eligible-route");
  assert.equal(payload.selectedRouteId, null);
  assert.deepEqual(validateCliJson(payload), { ok: true });
  for (const candidate of payload.rankedCandidates) {
    assert.equal(candidate.eligible, false);
    assert.ok(
      candidate.reasons.length > 0,
      `${candidate.routeId} names no excluding requirement`,
    );
  }

  const humanRun = await runSelect(baseArgs, { expectFailure: true });
  assert.equal(humanRun.code, 3);
  assert.equal(humanRun.stderr, "");
  assert.match(humanRun.stdout, /No eligible route\./);
  for (const candidate of payload.rankedCandidates) {
    assert.match(
      humanRun.stdout,
      new RegExp(`${candidate.routeId.replace("/", "\\/")} — excluded \\([^)]+\\)`),
      `human output must name the requirement excluding ${candidate.routeId}`,
    );
  }
});
