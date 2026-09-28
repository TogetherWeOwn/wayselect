import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { computeCatalogSnapshotHash } from "../src/index.js";
import { validateCliJson } from "../src/validate-cli-json.js";
import { evaluationNow, readFixture } from "../support/helpers.js";

// TOG-7290: golden pin for the empty-input `select` UX (test-only, no
// src/bin changes). Two empty inputs, both outputs, exact bytes:
//
//   - empty catalog (`{}` body, `{"candidates": []}` configuration):
//     human + --json print `no-eligible-route` with zero ranked candidates,
//     exit 3.
//   - empty configuration (`{"candidates": []}` over the pinned fixtures):
//     every candidate is excluded with its reason, exit 3.
//   - empty catalog with the DEFAULT configuration fails closed: exit 1
//     naming the first dangling route, empty stdout.
//
// Only `select` is pinned: `explain` shares the machine shape and the exit
// wiring through runSelectCommand (explain --json is select --json apart
// from `command`, pinned in test/cli-json-contract.test.js).
//
// Refresh-proofing: the empty catalog is a fully authored temp-dir fixture
// with fixed clocks (snapshot + 2h eval, same pattern as
// test/select-output-contract.test.js), so it never moves. The empty
// configuration runs over the live fixtures, so the clock (evaluationNow,
// snapshot + 2h) and the provenance line interpolate the live snapshot;
// every ranked line is clock-free by construction (an empty configuration
// carries no evidence, so no evidence reason can appear) and is compared
// literally. A fixture-content change fails this pin intentionally.
//
// Known gap, documented not fixed (test-only card): the empty-catalog
// --json payload carries `"rankedCandidates": []`, which the v1 schema
// rejects (`minItems: 1`). The test pins the validator outcome so widening
// the schema is a deliberate contract change with its own review.

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Live-fixture clock: snapshot + 2h keeps the catalog fresh and the evidence
// inside its 72h window across provenance refreshes.
const EVAL_ISO = evaluationNow().toISOString();

// Fully fixed clocks for the authored empty catalog: the temp fixture
// carries its own provenance, so these never move.
const EMPTY_SNAPSHOT_ISO = "2026-09-26T14:00:00.000Z";
const EMPTY_EVAL_ISO = "2026-09-26T16:00:00.000Z";
const EMPTY_SOURCE = "synthetic://wayselect/fixture-v1";

// SHA-256 of the canonical empty catalog body `"{}"`; pinned literally so a
// hashing change fails closed, and asserted against the live computation so
// the authored fixture provably carries the right integrity hash.
const EMPTY_CATALOG_HASH =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const SELECT_FLAGS = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
];

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

// An empty catalog is only valid alongside an empty configuration: the
// default configuration references routes the empty body cannot contain,
// and applySupportConfiguration fails closed on the first dangling route.
async function writeEmptyPair(dir) {
  assert.equal(computeCatalogSnapshotHash({}), EMPTY_CATALOG_HASH);
  const catalogPath = await writeTempJson(dir, "empty-catalog.json", {
    catalog: {},
    provenance: {
      source: EMPTY_SOURCE,
      snapshotTimestamp: EMPTY_SNAPSHOT_ISO,
      snapshotHash: EMPTY_CATALOG_HASH,
    },
  });
  const configurationPath = await writeTempJson(dir, "empty-configuration.json", {
    candidates: [],
  });
  return { catalogPath, configurationPath };
}

function withNormalizedFetchedAt(payload) {
  return { ...payload, provenance: { ...payload.provenance, fetchedAt: "<FETCHED_AT>" } };
}

test("TOG-7290: empty catalog prints the zero-candidate human page and exits 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-empty-inputs-"));
  try {
    const { catalogPath, configurationPath } = await writeEmptyPair(dir);
    const { code, stdout, stderr } = await runSelect(
      [
        "--catalog",
        catalogPath,
        "--configuration",
        configurationPath,
        ...SELECT_FLAGS,
        "--evaluation-time",
        EMPTY_EVAL_ISO,
      ],
      { expectFailure: true },
    );

    assert.equal(code, 3);
    assert.equal(stderr, "");
    assert.equal(
      stdout,
      "dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use\n" +
        "No eligible route.\n" +
        "Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id\n" +
        "Rates are synthetic/list-price estimates only; not actual cost or savings.\n" +
        "\n" +
        "Ranked candidates (0 eligible, 0 excluded):\n" +
        "\n" +
        `Provenance: ${EMPTY_SOURCE} @ ${EMPTY_SNAPSHOT_ISO}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TOG-7290: empty catalog --json pins the zero-candidate shape and exits 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-empty-inputs-"));
  try {
    const { catalogPath, configurationPath } = await writeEmptyPair(dir);
    const { code, stdout, stderr } = await runSelect(
      [
        "--catalog",
        catalogPath,
        "--configuration",
        configurationPath,
        ...SELECT_FLAGS,
        "--evaluation-time",
        EMPTY_EVAL_ISO,
        "--json",
      ],
      { expectFailure: true },
    );

    assert.equal(code, 3);
    assert.equal(stderr, "");
    const payload = JSON.parse(stdout);
    assert.match(
      payload.provenance.fetchedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      "fetchedAt stays a wall-clock ISO timestamp",
    );
    assert.equal(
      JSON.stringify(withNormalizedFetchedAt(payload), null, 2),
      JSON.stringify(
        {
          command: "select",
          // TOG-8326: in-band machine-schema version marker (const: v1).
          schemaVersion: "v1",
          dryRun: true,
          dryRunLabel:
            "dry-run / synthetic estimate — no live model calls, credentials, or network use",
          status: "no-eligible-route",
          selectedRouteId: null,
          policy: "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
          rateDisclaimer: "Synthetic/list-price estimates only; not actual cost or savings.",
          provenance: {
            source: EMPTY_SOURCE,
            snapshotTimestamp: EMPTY_SNAPSHOT_ISO,
            snapshotHash: EMPTY_CATALOG_HASH,
            fetchedAt: "<FETCHED_AT>",
          },
          request: {
            operation: "chat",
            requiredCapabilities: ["toolUse"],
            providerAllowlist: ["northstar", "orbit"],
            requirements: {},
          },
          evaluationTime: EMPTY_EVAL_ISO,
          maxEvidenceAgeHours: 72,
          rankedCandidates: [],
        },
        null,
        2,
      ),
    );
    // Known gap (see header): v1 requires at least one ranked candidate, so
    // the honest empty result does not validate. Pinned so widening the
    // schema is a deliberate contract change, not drift.
    const validation = validateCliJson(payload);
    assert.equal(validation.ok, false);
    assert.match(validation.error, /fewer than 1|minItems/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TOG-7290: empty configuration excludes every candidate in human output and exits 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-empty-inputs-"));
  try {
    const liveCatalog = await readFixture("catalog.synthetic.json");
    const snapshotTimestamp = liveCatalog.provenance.snapshotTimestamp;
    const configurationPath = await writeTempJson(dir, "empty-configuration.json", {
      candidates: [],
    });
    const { code, stdout, stderr } = await runSelect(
      [
        "--configuration",
        configurationPath,
        ...SELECT_FLAGS,
        "--evaluation-time",
        EVAL_ISO,
      ],
      { expectFailure: true },
    );

    assert.equal(code, 3);
    assert.equal(stderr, "");
    assert.equal(
      stdout,
      "dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use\n" +
        "No eligible route.\n" +
        "Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id\n" +
        "Rates are synthetic/list-price estimates only; not actual cost or savings.\n" +
        "\n" +
        "Ranked candidates (0 eligible, 6 excluded):\n" +
        "  1. legacy/old-chat — excluded (support-state:catalogued, provider-not-allowed, operation-not-configured)\n" +
        "  2. northstar/alpha-chat — excluded (support-state:catalogued, operation-not-configured)\n" +
        "  3. northstar/image-lite — excluded (support-state:catalogued, operation-not-catalogued, operation-not-configured, unsupported-capability:toolUse)\n" +
        "  4. northstar/unknown-tools — excluded (support-state:catalogued, operation-not-configured, missing-capability:toolUse)\n" +
        "  5. orbit/orbit-chat — excluded (support-state:catalogued, operation-not-configured)\n" +
        "  6. orbit/retired-chat — excluded (support-state:catalogued, operation-not-configured)\n" +
        "\n" +
        `Provenance: synthetic://wayselect/fixture-v1 @ ${snapshotTimestamp}\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TOG-7290: empty configuration --json pins every exclusion reason and exits 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-empty-inputs-"));
  try {
    const liveCatalog = await readFixture("catalog.synthetic.json");
    const snapshotTimestamp = liveCatalog.provenance.snapshotTimestamp;
    const snapshotHash = liveCatalog.provenance.snapshotHash;
    const configurationPath = await writeTempJson(dir, "empty-configuration.json", {
      candidates: [],
    });
    const { code, stdout, stderr } = await runSelect(
      [
        "--configuration",
        configurationPath,
        ...SELECT_FLAGS,
        "--evaluation-time",
        EVAL_ISO,
        "--json",
      ],
      { expectFailure: true },
    );

    assert.equal(code, 3);
    assert.equal(stderr, "");
    const payload = JSON.parse(stdout);
    assert.match(
      payload.provenance.fetchedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      "fetchedAt stays a wall-clock ISO timestamp",
    );
    // The CLI echoes the live fixture provenance; a stale echo fails here.
    assert.equal(payload.provenance.snapshotTimestamp, snapshotTimestamp);
    assert.equal(payload.provenance.snapshotHash, snapshotHash);
    assert.equal(
      JSON.stringify(withNormalizedFetchedAt(payload), null, 2),
      JSON.stringify(
        {
          command: "select",
          // TOG-8326: in-band machine-schema version marker (const: v1).
          schemaVersion: "v1",
          dryRun: true,
          dryRunLabel:
            "dry-run / synthetic estimate — no live model calls, credentials, or network use",
          status: "no-eligible-route",
          selectedRouteId: null,
          policy: "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
          rateDisclaimer: "Synthetic/list-price estimates only; not actual cost or savings.",
          provenance: {
            source: "synthetic://wayselect/fixture-v1",
            snapshotTimestamp,
            snapshotHash,
            fetchedAt: "<FETCHED_AT>",
          },
          request: {
            operation: "chat",
            requiredCapabilities: ["toolUse"],
            providerAllowlist: ["northstar", "orbit"],
            requirements: {},
          },
          evaluationTime: EVAL_ISO,
          maxEvidenceAgeHours: 72,
          rankedCandidates: [
            {
              rank: 1,
              routeId: "legacy/old-chat",
              providerId: "legacy",
              modelId: "old-chat",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 2,
              reasons: [
                "support-state:catalogued",
                "provider-not-allowed",
                "operation-not-configured",
              ],
            },
            {
              rank: 2,
              routeId: "northstar/alpha-chat",
              providerId: "northstar",
              modelId: "alpha-chat",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 3,
              reasons: ["support-state:catalogued", "operation-not-configured"],
            },
            {
              rank: 3,
              routeId: "northstar/image-lite",
              providerId: "northstar",
              modelId: "image-lite",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 2,
              reasons: [
                "support-state:catalogued",
                "operation-not-catalogued",
                "operation-not-configured",
                "unsupported-capability:toolUse",
              ],
            },
            {
              rank: 4,
              routeId: "northstar/unknown-tools",
              providerId: "northstar",
              modelId: "unknown-tools",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 0.75,
              reasons: [
                "support-state:catalogued",
                "operation-not-configured",
                "missing-capability:toolUse",
              ],
            },
            {
              rank: 5,
              routeId: "orbit/orbit-chat",
              providerId: "orbit",
              modelId: "orbit-chat",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 3,
              reasons: ["support-state:catalogued", "operation-not-configured"],
            },
            {
              rank: 6,
              routeId: "orbit/retired-chat",
              providerId: "orbit",
              modelId: "retired-chat",
              supportState: "catalogued",
              eligible: false,
              estimatedRatePerMillion: 0.2,
              reasons: ["support-state:catalogued", "operation-not-configured"],
            },
          ],
        },
        null,
        2,
      ),
    );
    assert.deepEqual(validateCliJson(payload), { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TOG-7290: empty catalog with the default configuration fails closed and exits 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-empty-inputs-"));
  try {
    const { catalogPath } = await writeEmptyPair(dir);
    const { code, stdout, stderr } = await runSelect(
      ["--catalog", catalogPath, ...SELECT_FLAGS, "--evaluation-time", EMPTY_EVAL_ISO],
      { expectFailure: true },
    );

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.equal(
      stderr,
      "error: configuration.candidates[0].routeId is not present in the catalog: legacy/old-chat\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
