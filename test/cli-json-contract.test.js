// Tests for TOG-5734: versioned schema snapshot for CLI --json output.
//
// `select --json` / `explain --json` had no contract: consumers could not
// detect breaking changes. The shape is now pinned two ways, and both pins
// fail on undeclared changes:
//
//   1. Structural: schema/cli-json/v1.json via src/validate-cli-json.js.
//      additionalProperties is false at every object level, so any added,
//      removed, or renamed field fails validation.
//   2. Values: test/fixtures/cli-json-{select,explain,no-route}.v1.json,
//      byte-level snapshots of live CLI output with volatile fields scrubbed.
//
// Refresh-proofing: the suite clock is snapshot + 2h (support/helpers.js), so
// the catalog gate and the evidence window stay green across provenance
// refreshes. Absolute ISO timestamps and the snapshot hash move on refresh,
// so both sides are normalized (<TIMESTAMP>/<HASH>) before the byte
// comparison; the normalized-away fields are asserted well-formed
// separately. Everything else — commands, statuses, policies, ranks, reasons,
// rates — is refresh-stable and compared exactly.
//
// Bump procedure: docs/cli-json-contract.md. Fixture-only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateCliJson } from "../src/validate-cli-json.js";
import { evaluationNow } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const SELECT_ARGS = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
];
const NO_ROUTE_ARGS = [
  "--operation",
  "chat",
  "--require",
  "vision",
  "--allow",
  "northstar",
];

function normalizeVolatile(serialized) {
  return serialized
    .replace(
      /<fetchedAt: wall-clock at evaluation, any ISO timestamp>/g,
      "<TIMESTAMP>",
    )
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    .replace(/sha256:[a-f0-9]{64}/g, "<HASH>");
}

async function runJson(command, extraArgs) {
  const evaluationTime = evaluationNow().toISOString();
  const args = [
    command,
    ...extraArgs,
    "--evaluation-time",
    evaluationTime,
    "--json",
  ];
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/wayselect", ...args],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr, evaluationTime };
  } catch (error) {
    return {
      code: error.code,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      evaluationTime,
    };
  }
}

async function readSnapshot(name) {
  return readFile(
    new URL(`./fixtures/${name}.v1.json`, import.meta.url),
    "utf8",
  );
}

function assertWellFormedVolatile(payload) {
  for (const field of ["evaluationTime", "provenance.snapshotTimestamp", "provenance.fetchedAt"]) {
    const value = field
      .split(".")
      .reduce((node, key) => node[key], payload);
    assert.match(
      value,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      `${field} must be an ISO timestamp, got: ${value}`,
    );
  }
  assert.match(
    payload.provenance.snapshotHash,
    /^sha256:[a-f0-9]{64}$/,
  );
}

test("TOG-5734: select --json validates against the v1 schema", async () => {
  const { code, stdout, stderr } = await runJson("select", SELECT_ARGS);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.deepEqual(validateCliJson(payload), { ok: true });
  assertWellFormedVolatile(payload);
});

test("TOG-5734: select --json matches the checked-in snapshot", async () => {
  const { stdout } = await runJson("select", SELECT_ARGS);
  const expected = await readSnapshot("cli-json-select");
  assert.equal(
    normalizeVolatile(JSON.stringify(JSON.parse(stdout), null, 2)),
    normalizeVolatile(expected.trimEnd()),
    "select --json drifted from test/fixtures/cli-json-select.v1.json — " +
      "see docs/cli-json-contract.md for the bump procedure",
  );
});

test("TOG-5734: explain --json validates and matches its snapshot", async () => {
  const { code, stdout, stderr } = await runJson("explain", SELECT_ARGS);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.command, "explain");
  assert.deepEqual(validateCliJson(payload), { ok: true });
  const expected = await readSnapshot("cli-json-explain");
  assert.equal(
    normalizeVolatile(JSON.stringify(payload, null, 2)),
    normalizeVolatile(expected.trimEnd()),
    "explain --json drifted from test/fixtures/cli-json-explain.v1.json — " +
      "see docs/cli-json-contract.md for the bump procedure",
  );
});

test("TOG-5734: explain --json is select --json apart from command", async () => {
  const select = JSON.parse((await runJson("select", SELECT_ARGS)).stdout);
  const explain = JSON.parse((await runJson("explain", SELECT_ARGS)).stdout);
  // fetchedAt is stamped from the wall clock per invocation (docs/cli.md), so
  // it differs by milliseconds between the two runs; normalize before compare.
  const withoutCommand = ({ command: _command, provenance, ...rest }) => ({
    ...rest,
    provenance: { ...provenance, fetchedAt: "<TIMESTAMP>" },
  });
  assert.deepEqual(withoutCommand(explain), withoutCommand(select));
});

test("TOG-5734: no-eligible-route --json validates, snapshots, and exits 3", async () => {
  const { code, stdout, stderr } = await runJson("select", NO_ROUTE_ARGS);
  assert.equal(code, 3);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.status, "no-eligible-route");
  assert.equal(payload.selectedRouteId, null);
  assert.deepEqual(validateCliJson(payload), { ok: true });
  const expected = await readSnapshot("cli-json-no-route");
  assert.equal(
    normalizeVolatile(JSON.stringify(payload, null, 2)),
    normalizeVolatile(expected.trimEnd()),
    "no-route --json drifted from test/fixtures/cli-json-no-route.v1.json — " +
      "see docs/cli-json-contract.md for the bump procedure",
  );
});

test("TOG-5734: checked-in snapshots validate against the v1 schema", async () => {
  for (const name of ["cli-json-select", "cli-json-explain", "cli-json-no-route"]) {
    const raw = await readSnapshot(name);
    // The fixture scrubs the wall-clock fetchedAt; restore a fixed ISO so the
    // schema's date-time format check exercises the stored shape as-is.
    const payload = JSON.parse(
      raw.replace(
        "<fetchedAt: wall-clock at evaluation, any ISO timestamp>",
        "2026-09-26T16:00:00.000Z",
      ),
    );
    assert.deepEqual(
      validateCliJson(payload),
      { ok: true },
      `${name}.v1.json must validate against schema/cli-json/v1.json`,
    );
  }
});

test("TOG-5734: validator rejects undeclared top-level fields", async () => {
  const { stdout } = await runJson("select", SELECT_ARGS);
  const payload = JSON.parse(stdout);
  const result = validateCliJson({ ...payload, modelVersion: "v2" });
  assert.equal(result.ok, false);
  assert.match(result.error, /additionalProperties|must NOT have additional/);
});

test("TOG-5734: validator rejects undeclared nested fields", async () => {
  const { stdout } = await runJson("select", SELECT_ARGS);
  const payload = JSON.parse(stdout);
  const tampered = {
    ...payload,
    rankedCandidates: [
      { ...payload.rankedCandidates[0], latencyMs: 12 },
    ],
  };
  const result = validateCliJson(tampered);
  assert.equal(result.ok, false);
  assert.match(result.error, /additionalProperties|must NOT have additional/);
});

test("TOG-5734: validator rejects status/selection mismatches", async () => {
  const { stdout } = await runJson("select", SELECT_ARGS);
  const selected = JSON.parse(stdout);
  assert.equal(
    validateCliJson({ ...selected, selectedRouteId: null }).ok,
    false,
  );
  const noRoute = JSON.parse((await runJson("select", NO_ROUTE_ARGS)).stdout);
  assert.equal(
    validateCliJson({ ...noRoute, selectedRouteId: "northstar/alpha-chat" }).ok,
    false,
  );
});

test("TOG-5734: validator rejects broken rank and eligibility invariants", async () => {
  const { stdout } = await runJson("select", SELECT_ARGS);
  const payload = JSON.parse(stdout);
  const [first, ...rest] = payload.rankedCandidates;

  const badRank = {
    ...payload,
    rankedCandidates: [{ ...first, rank: 2 }, ...rest],
  };
  assert.match(validateCliJson(badRank).error, /rank/);

  const eligibleWithReasons = {
    ...payload,
    rankedCandidates: [{ ...first, reasons: ["stale-evidence"] }, ...rest],
  };
  assert.match(validateCliJson(eligibleWithReasons).error, /eligible but carries reasons/);

  const last = rest[rest.length - 1];
  const excludedWithoutReasons = {
    ...payload,
    rankedCandidates: [first, ...rest.slice(0, -1), { ...last, reasons: [] }],
  };
  assert.match(validateCliJson(excludedWithoutReasons).error, /carries no reasons/);
});

test("TOG-5734: validator rejects non-objects and mistyped scalars", async () => {
  for (const bad of [null, [], "select", 42]) {
    assert.equal(validateCliJson(bad).ok, false);
  }
  const { stdout } = await runJson("select", SELECT_ARGS);
  const payload = JSON.parse(stdout);
  assert.equal(validateCliJson({ ...payload, dryRun: false }).ok, false);
  assert.equal(validateCliJson({ ...payload, command: "frobnicate" }).ok, false);
});
