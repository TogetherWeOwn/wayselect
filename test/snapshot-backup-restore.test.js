// Tests for TOG-8327: snapshot backup/restore + catalog rollback wiring.
//
// The procedure itself lives in docs/snapshot-backup-restore.md and the
// end-to-end drill in bin/accept-snapshot-restore (which proves the restore
// commands on scratch copies, including the full suite, and exits 0 only on
// 5/5). That drill is operator-run, like bin/accept-fixture-refresh — it is
// deliberately NOT part of this suite. These tests pin the wiring that rots:
// the doc exists and is reachable (README index + operator catalog row), the
// npm script is registered, and the harness help/usage contract holds.
// Offline, stdlib only, no fixtures beyond text reads, no writes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const README = new URL("../README.md", import.meta.url);
const DOC = new URL("../docs/snapshot-backup-restore.md", import.meta.url);
const CATALOG_DOC = new URL("../docs/bin-operator-catalog.md", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);

const HARNESS_HELP = "Usage: node bin/accept-snapshot-restore [--out evidence.json] [--keep-tmp]\n";

async function runHarness(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["bin/accept-snapshot-restore", ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("TOG-8327: runbook doc exists and names the recovery order", () => {
  const doc = readFileSync(DOC, "utf8");
  assert.match(doc, /^# Snapshot backup\/restore \+ catalog rollback \(TOG-8327\)/m);
  for (const anchor of [
    "bin/refresh-catalog-fixtures --check",
    "bin/check-ingestion-provenance",
    "bin/wayselect-snapshot --catalog",
    "--previous",
    "removedCount",
    "CatalogIntegrityError",
    "bin/accept-snapshot-restore",
    "Reviewer walk",
  ]) {
    assert.ok(doc.includes(anchor), `runbook must document ${anchor}`);
  }
});

test("TOG-8327: runbook is linked from the README docs index", () => {
  const readme = readFileSync(README, "utf8");
  assert.ok(
    readme.includes("docs/snapshot-backup-restore.md"),
    "README.md docs index must link docs/snapshot-backup-restore.md (CONTRIBUTING.md: new docs go in the index)",
  );
});

test("TOG-8327: operator catalog carries the drill row", () => {
  const catalog = readFileSync(CATALOG_DOC, "utf8");
  assert.ok(
    catalog.includes("`bin/accept-snapshot-restore`"),
    "docs/bin-operator-catalog.md must carry the bin/accept-snapshot-restore row",
  );
  assert.ok(
    catalog.includes("docs/snapshot-backup-restore.md"),
    "docs/bin-operator-catalog.md related-docs must point at the runbook",
  );
});

test("TOG-8327: npm script registers the drill", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_URL, "utf8"));
  assert.equal(
    pkg.scripts["accept:snapshot-restore"],
    "node bin/accept-snapshot-restore",
    "package.json must register npm run accept:snapshot-restore",
  );
});

test("TOG-8327: harness --help pins exact bytes", async () => {
  const result = await runHarness(["--help"]);
  assert.equal(result.code, 0, "--help must exit 0");
  assert.equal(result.stderr, "", "--help must keep stderr empty");
  assert.equal(result.stdout, HARNESS_HELP, "--help must print the exact usage line");
});

test("TOG-8327: harness rejects unknown flags", async () => {
  const result = await runHarness(["--bogus"]);
  assert.equal(result.code, 2, "unknown flag must exit 2");
  // The harness catch prints the error stack, so the first stderr line
  // carries an `Error: ` prefix (same shape as bin/accept-fixture-refresh).
  assert.match(result.stderr, /^ERROR: (Error: )?Unknown argument: --bogus/m);
});
