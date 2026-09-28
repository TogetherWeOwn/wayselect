// Catalog-import quarantine human-output golden (TOG-7300, test-only).
//
// `wayselect catalog import` (human output, no --json) prints a
// `Quarantined N:` block listing every rejected route with its reason.
// bin/wayselect already renders it (`Quarantined ${n}:` + `  - route: reason`
// lines); test/cli.test.js only regex-pins it (`/Quarantined 1:/` +
// `/acme\/mystery: .*unknown field: frobnicate/`). This file golden-pins the
// exact block bytes and their placement for a fixture with one quarantined
// entry, so any reword/reorder/reindent fails loudly.
//
// Fixture is small and newly authored (temp-dir models.dev-shaped input, fixed
// --source/--snapshot-timestamp, no --fetch, no network): one clean model
// (acme/chat-one) plus one unknown-field model (acme/mystery with
// `frobnicate: true`). Snapshot/raw hashes are deterministic for this input
// and pinned exactly (they match test/fixtures/cli-json-catalog-import.v1.json
// from TOG-7302); the quarantine lines are the acceptance bar.
//
// No source change: bin/wayselect already emits the block. Offline
// (CONTRIBUTING.md: no network in tests). Node stdlib only.

import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const SOURCE = "https://models.dev/api.json";
const SNAPSHOT_TIMESTAMP = "2026-09-24T10:00:00.000Z";
// Deterministic for the fixture below (matches TOG-7302's checked-in --json
// snapshot for the same input shape).
const SNAPSHOT_HASH = "sha256:29c1986a3039ed49dae8a62c95aa77db37598e4f5ca5cea0490300c0d2eef6f3";
const RAW_HASH = "sha256:e8ea768e131c7464a6e3ce5139af9849f2f204082adf5fdf289ecf8cd59dd88e";
const QUARANTINE_LINE = "  - acme/mystery: provider acme model mystery contains unknown field: frobnicate";

function importInput() {
  return {
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
        mystery: {
          id: "mystery",
          name: "Mystery",
          modalities: { input: ["text"], output: ["text"] },
          frobnicate: true,
        },
      },
    },
  };
}

async function runImportHuman() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-quarantine-golden-"));
  try {
    const inputPath = join(dir, "models-dev-sample.json");
    await writeFile(inputPath, JSON.stringify(importInput()));
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect",
        "catalog",
        "import",
        inputPath,
        "--source",
        SOURCE,
        "--snapshot-timestamp",
        SNAPSHOT_TIMESTAMP,
      ],
      { cwd: repoRoot },
    );
    return { stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("catalog-import quarantine human-output golden (TOG-7300)", () => {
  it("pins the Quarantined block byte-identical with exact placement", async () => {
    const { stdout, stderr } = await runImportHuman();
    strictEqual(stderr, "");
    const lines = stdout.split("\n");
    // 8 content lines + trailing newline.
    deepStrictEqual(lines, [
      "catalog import — dry-run only (support state: catalogued only)",
      `Source: ${SOURCE} @ ${SNAPSHOT_TIMESTAMP}`,
      `Snapshot hash: ${SNAPSHOT_HASH}`,
      `Raw input hash: ${RAW_HASH}`,
      "Ingested 1 entry from 1 provider (support state: catalogued only).",
      "Quarantined 1:",
      QUARANTINE_LINE,
      "No --out path given; catalog document not written.",
      "",
    ]);
  });

  it("quarantine block names the count, route, and reason on exact bytes", async () => {
    const { stdout } = await runImportHuman();
    const block = stdout.split("\n").slice(5, 7);
    deepStrictEqual(block, ["Quarantined 1:", QUARANTINE_LINE]);
    ok(!stdout.includes("Quarantined 0"), "no zero-count block");
    strictEqual(
      stdout.split("\n").filter((line) => line.startsWith("  - ")).length,
      1,
      "exactly one quarantined entry line",
    );
  });
});
