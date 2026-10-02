// Tests for TOG-8326: stable in-band machine-schema version marker.
//
// `select --json` / `explain --json` / `catalog import --json` carry a
// top-level `schemaVersion` field pinned to `const: "v1"` in
// schema/cli-json/v1.json. Consumers pin on this marker instead of sniffing
// the shape, so a breaking change must bump the version (per
// docs/cli-json-contract.md) rather than silently shifting the output.
//
// What fails on what change:
//   - The emitter drops/renames the marker, or the schema drops the
//     requirement: the live-output tests below fail (validation rejects).
//   - Someone bumps the version (emitter + schema + SCHEMA_VERSION to "v2"
//     with a new schema file): the `SCHEMA_VERSION is pinned to "v1"` test
//     fails until the bump is made deliberately here too — the bump breaks
//     this test, not downstream users.
//   - A shape change without a version bump: the schema's
//     additionalProperties-fail-closed pins in test/cli-json-contract.test.js
//     fail.
//
// Fixture-only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  validateCliJson,
  SCHEMA_VERSION,
} from "../src/validate-cli-json.js";
import { evaluationNow } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

async function runSelectJson(command, extraArgs) {
  const evaluationTime = evaluationNow().toISOString();
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "bin/wayselect",
      command,
      ...extraArgs,
      "--evaluation-time",
      evaluationTime,
      "--json",
    ],
    { cwd: repoRoot },
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout);
}

async function runImportJson() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-schema-version-"));
  try {
    const inputPath = join(dir, "models-dev-sample.json");
    await writeFile(
      inputPath,
      JSON.stringify({
        acme: {
          id: "acme",
          name: "Acme Synthetic",
          models: {
            "chat-one": {
              id: "chat-one",
              name: "Chat One",
              attachment: false,
              reasoning: false,
              tool_call: true,
              structured_output: true,
              modalities: { input: ["text"], output: ["text"] },
              cost: { input: 1, output: 2 },
              limit: { context: 8000, output: 2000 },
            },
          },
        },
      }),
    );
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect",
        "catalog",
        "import",
        inputPath,
        "--source",
        "https://models.dev/api.json",
        "--snapshot-timestamp",
        "2026-09-24T10:00:00.000Z",
        "--json",
      ],
      { cwd: repoRoot },
    );
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SELECT_ARGS = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
];

test("TOG-8326: SCHEMA_VERSION is pinned to v1 — bump it deliberately, never silently", async () => {
  // A version bump (new schema file, emitter + validator switched over) must
  // edit this line on purpose. If this fails after a shape change, follow the
  // bump procedure in docs/cli-json-contract.md instead of deleting the pin.
  assert.equal(SCHEMA_VERSION, "v1");
});

for (const command of ["select", "explain"]) {
  test(`TOG-8326: ${command} --json carries the stable version marker and validates`, async () => {
    const payload = await runSelectJson(command, SELECT_ARGS);
    assert.equal(
      payload.schemaVersion,
      SCHEMA_VERSION,
      `${command} --json must carry schemaVersion ${JSON.stringify(SCHEMA_VERSION)}`,
    );
    assert.deepEqual(validateCliJson(payload), { ok: true });
  });
}

test("TOG-8326: catalog import --json carries the stable version marker and validates", async () => {
  const payload = await runImportJson();
  assert.equal(
    payload.schemaVersion,
    SCHEMA_VERSION,
    `catalog import --json must carry schemaVersion ${JSON.stringify(SCHEMA_VERSION)}`,
  );
  assert.deepEqual(validateCliJson(payload), { ok: true });
});

test("TOG-8326: validator rejects a payload with the version marker removed", async () => {
  const payload = await runSelectJson("select", SELECT_ARGS);
  const { schemaVersion: _dropped, ...withoutMarker } = payload;
  const result = validateCliJson(withoutMarker);
  assert.equal(result.ok, false);
  assert.match(result.error, /schemaVersion/);
});

test("TOG-8326: validator rejects a payload with a wrong version marker", async () => {
  const payload = await runSelectJson("select", SELECT_ARGS);
  const result = validateCliJson({ ...payload, schemaVersion: "v2" });
  assert.equal(result.ok, false);
  assert.match(result.error, /schemaVersion|const/);
});
