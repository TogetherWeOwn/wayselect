// Tests for TOG-5725: snapshot byte-determinism.
//
// `bin/wayselect-snapshot --now <iso>` must serialize byte-identically for the
// same input: before this card, provenance.fetchedAt was stamped from the wall
// clock inside normalizeCatalog, so two same-input runs differed at one byte
// range and any diff of the pair reported provenanceChanged:true. The snapshot
// clock is now forwarded into the fetchedAt default, so a pinned --now is a
// byte-identical no-op. Clocks derive from the live fixture snapshot (same +2h
// distance as the suite clock) so provenance refreshes never break these
// tests.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSnapshot } from "../src/snapshot.js";
import { diffSnapshots, formatDiffReport } from "../src/catalogDiff.js";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

async function fixedNow() {
  const fixture = await readFixture("catalog.synthetic.json");
  return new Date(
    Date.parse(fixture.provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000,
  ).toISOString();
}

async function buildAt(now) {
  const fixture = await readFixture("catalog.synthetic.json");
  return buildSnapshot(fixture.catalog, fixture.provenance, {
    now,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
  });
}

test("TOG-5725: same-input snapshot builds serialize byte-identically", async () => {
  const now = await fixedNow();
  const first = await buildAt(now);
  // Separate the builds in wall-clock time so the test genuinely pins the
  // clock input instead of passing via a same-millisecond collision.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await buildAt(now);

  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    "identical input + identical clock must serialize to identical bytes",
  );
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.provenance.fetchedAt, first.provenance.fetchedAt);

  const diff = diffSnapshots(first, second);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.summary.contentHashChanged, false);
  assert.equal(
    diff.summary.provenanceChanged,
    false,
    "same-input re-runs must not report a provenance change",
  );
  assert.match(formatDiffReport(diff), /No route changes between snapshots/);
});

test("TOG-5725: snapshot CLI writes byte-identical files for the same --now", async () => {
  const now = await fixedNow();
  const firstDir = await fs.mkdtemp(join(tmpdir(), "wayselect-determinism-a-"));
  const secondDir = await fs.mkdtemp(join(tmpdir(), "wayselect-determinism-b-"));
  try {
    const runCli = (outDir) =>
      execFileAsync(
        process.execPath,
        ["bin/wayselect-snapshot", "--out", outDir, "--now", now, "--max-catalog-age-hours", "24"],
        { cwd: repoRoot },
      );

    const first = JSON.parse((await runCli(firstDir)).stdout);
    const second = JSON.parse((await runCli(secondDir)).stdout);

    assert.equal(
      second.snapshotPath,
      first.snapshotPath,
      "same clock + same catalog must name the same snapshot file",
    );
    assert.equal(second.contentHash, first.contentHash);

    const [firstBytes, secondBytes] = await Promise.all([
      fs.readFile(join(firstDir, first.snapshotPath), "utf8"),
      fs.readFile(join(secondDir, second.snapshotPath), "utf8"),
    ]);
    assert.equal(
      secondBytes,
      firstBytes,
      "same-input snapshot refresh must be byte-identical on disk",
    );
  } finally {
    await fs.rm(firstDir, { recursive: true, force: true });
    await fs.rm(secondDir, { recursive: true, force: true });
  }
});
