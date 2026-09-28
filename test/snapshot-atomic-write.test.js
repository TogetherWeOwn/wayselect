// Tests for TOG-6726: atomic snapshot writes.
//
// `bin/wayselect-snapshot` wrote snapshots and diff reports with a direct
// `writeFile`: a crash mid-write left a truncated file that later runs read
// back as a corrupt snapshot. Both writes now go through
// `src/atomicWrite.js` (temp file in the same directory + fsync + rename),
// so readers only ever observe the old bytes or the new bytes.
//
// These tests pin that contract without touching the network:
//   - the helper publishes exact bytes and leaves no temp residue;
//   - a write that fails before the rename (simulated mid-write crash)
//     leaves a pre-existing target byte-identical, creates no target when
//     none existed, and cleans up the temp file;
//   - at the CLI level, a truncated snapshot left by a simulated crash is
//     replaced by a whole parseable snapshot on rerun, with no temp residue
//     left in the output directory.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "../src/atomicWrite.js";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Refresh-proof clock: derived from the live fixture snapshot (same +2h
// distance as the suite clock) so provenance refreshes never break these
// tests.
async function freshNow() {
  const fixture = await readFixture("catalog.synthetic.json");
  return new Date(
    Date.parse(fixture.provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000,
  ).toISOString();
}

async function tempResidue(dir) {
  return (await fs.readdir(dir)).filter((name) => name.includes(".tmp."));
}

test("TOG-6726: helper publishes exact bytes with no temp residue", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wayselect-atomic-ok-"));
  try {
    const target = join(dir, "snapshot-20260924T120000000Z-abcdef12.json");
    const payload = `${JSON.stringify({ tool: "wayselect-snapshot", n: 1 }, null, 2)}\n`;
    await writeFileAtomic(target, payload);
    assert.equal(await fs.readFile(target, "utf8"), payload);
    assert.deepEqual(await tempResidue(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TOG-6726: mid-write failure keeps the previous snapshot byte-identical", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wayselect-atomic-crash-"));
  try {
    const target = join(dir, "snapshot-20260924T120000000Z-abcdef12.json");
    const previous = `${JSON.stringify({ tool: "wayselect-snapshot", n: 1 }, null, 2)}\n`;
    await fs.writeFile(target, previous);

    // `undefined` fails inside the temp-file write, before the rename ever
    // runs — the same observable state as a crash mid-write.
    await assert.rejects(writeFileAtomic(target, undefined));

    assert.equal(
      await fs.readFile(target, "utf8"),
      previous,
      "a failed write must leave the previous snapshot untouched, never truncated",
    );
    assert.deepEqual(await tempResidue(dir), [], "failed writes must clean up the temp file");
    assert.deepEqual(await fs.readdir(dir), ["snapshot-20260924T120000000Z-abcdef12.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TOG-6726: mid-write failure with no previous snapshot leaves no file", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wayselect-atomic-absent-"));
  try {
    const target = join(dir, "snapshot-20260924T120000000Z-abcdef12.json");
    await assert.rejects(writeFileAtomic(target, undefined));
    assert.deepEqual(await fs.readdir(dir), [], "no half-written file may be observable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TOG-6726: CLI rerun heals a truncated snapshot with no residue", async () => {
  const outDir = await fs.mkdtemp(join(tmpdir(), "wayselect-atomic-cli-"));
  try {
    const now = await freshNow();
    const args = [
      "bin/wayselect-snapshot",
      "--out",
      outDir,
      "--now",
      now,
      "--max-catalog-age-hours",
      "24",
    ];
    const first = JSON.parse((await execFileAsync(process.execPath, args, { cwd: repoRoot })).stdout);
    const snapshotPath = join(outDir, first.snapshotPath);
    const whole = await fs.readFile(snapshotPath, "utf8");
    JSON.parse(whole);

    // Simulate the crash the old direct writeFile allowed: truncate the
    // published file to half its bytes.
    await fs.writeFile(snapshotPath, whole.slice(0, Math.floor(whole.length / 2)));
    assert.throws(() => JSON.parse(whole.slice(0, Math.floor(whole.length / 2))), SyntaxError);

    const second = JSON.parse((await execFileAsync(process.execPath, args, { cwd: repoRoot })).stdout);
    assert.equal(second.snapshotPath, first.snapshotPath, "same clock must rewrite the same file");
    const healed = await fs.readFile(snapshotPath, "utf8");
    assert.equal(healed, whole, "rerun must restore the whole snapshot byte-for-byte");
    JSON.parse(healed);
    assert.deepEqual(await tempResidue(outDir), []);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test("TOG-6726: CLI diff report write leaves no temp residue", async () => {
  const outDir = await fs.mkdtemp(join(tmpdir(), "wayselect-atomic-report-"));
  try {
    const now = await freshNow();
    const base = ["bin/wayselect-snapshot", "--out", outDir, "--now", now, "--max-catalog-age-hours", "24"];
    const first = JSON.parse((await execFileAsync(process.execPath, base, { cwd: repoRoot })).stdout);
    const second = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [...base, "--previous", join(outDir, first.snapshotPath)],
          { cwd: repoRoot },
        )
      ).stdout,
    );
    const report = await fs.readFile(join(outDir, second.reportPath), "utf8");
    assert.match(report, /# Wayselect staging catalog snapshot diff/);
    assert.deepEqual(await tempResidue(outDir), []);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
