// Tests for TOG-5740: snapshot retention policy + prune script.
//
// `snapshots/` accumulated timestamped files with no retention rule.
// src/snapshotPrune.js plans the prune (pure, stdlib only) and
// bin/wayselect-snapshot-prune applies it: dry-run by default (lists, deletes
// nothing), `--apply` to delete. Only `snapshot-*.json` files are ever
// candidates; reports and anything else are always skipped.
//
// Offline by construction: the planner takes synthetic listings, and the CLI
// tests run against scratch copies (mkdtemp) — never the committed
// snapshots/ directory, never the network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_KEEP_LAST,
  DEFAULT_MAX_AGE_DAYS,
  SnapshotPruneError,
  planSnapshotPrune,
} from "../src/snapshotPrune.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-27T00:00:00.000Z");

function snapshotFiles(count, { startAgeDays = 0, stepDays = 1 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const ageDays = startAgeDays + index * stepDays;
    const stamp = new Date(NOW - ageDays * DAY_MS)
      .toISOString()
      .replace(/[-:.]/g, "");
    return {
      name: `snapshot-${stamp}-abcdef${index}.json`,
      mtimeMs: NOW - ageDays * DAY_MS,
    };
  });
}

// Scratch files land with wall-clock mtimes, so pin their mtimes to the
// synthetic ages the test reasons about; otherwise every file reads as
// "young" and nothing qualifies for pruning.
async function stageScratchFiles(dir, entries) {
  for (const entry of entries) {
    const path = join(dir, entry.name);
    await fs.writeFile(path, "{}\n");
    await fs.utimes(path, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
  }
}

test("TOG-5740: keep-last floor survives any age", () => {
  const files = snapshotFiles(12, { startAgeDays: 100, stepDays: 10 });
  const plan = planSnapshotPrune(files, { keepLast: 10, maxAgeDays: 30, now: NOW });

  assert.equal(plan.kept.length, 10);
  assert.equal(plan.pruned.length, 2);
  assert.deepEqual(plan.skipped, []);
  assert.ok(Object.isFrozen(plan));
});

test("TOG-5740: young overflow is kept even past the keep-last floor", () => {
  const files = snapshotFiles(15);
  const plan = planSnapshotPrune(files, { keepLast: 10, maxAgeDays: 30, now: NOW });

  assert.equal(plan.pruned.length, 0);
  assert.equal(plan.kept.length, 15);
});

test("TOG-5740: old overflow past both limits is pruned", () => {
  const young = snapshotFiles(10);
  const aged = snapshotFiles(5, { startAgeDays: 40, stepDays: 5 });
  const plan = planSnapshotPrune([...young, ...aged], {
    keepLast: 10,
    maxAgeDays: 30,
    now: NOW,
  });

  assert.deepEqual(
    [...plan.pruned].sort(),
    aged.map((entry) => entry.name).sort(),
  );
  assert.equal(plan.kept.length, 10);
});

test("TOG-5740: non-snapshot files are skipped, never candidates", () => {
  const files = [
    ...snapshotFiles(12, { startAgeDays: 100, stepDays: 10 }),
    { name: "diff-report-old-vs-new.md", mtimeMs: NOW - 200 * DAY_MS },
    { name: "sample-diff-with-changes.md", mtimeMs: NOW - 200 * DAY_MS },
    { name: "notes.txt", mtimeMs: NOW - 200 * DAY_MS },
  ];
  const plan = planSnapshotPrune(files, { keepLast: 10, maxAgeDays: 30, now: NOW });

  assert.deepEqual([...plan.skipped].sort(), [
    "diff-report-old-vs-new.md",
    "notes.txt",
    "sample-diff-with-changes.md",
  ]);
  assert.ok(!plan.pruned.some((name) => !name.startsWith("snapshot-")));
});

test("TOG-5740: equal mtimes break ties deterministically", () => {
  const files = Array.from({ length: 12 }, (_, index) => ({
    name: `snapshot-20260101T000000000Z-abcdef${String(index).padStart(2, "0")}.json`,
    mtimeMs: NOW - 100 * DAY_MS,
  }));
  const first = planSnapshotPrune(files, { keepLast: 10, maxAgeDays: 30, now: NOW });
  const second = planSnapshotPrune([...files].reverse(), {
    keepLast: 10,
    maxAgeDays: 30,
    now: NOW,
  });

  assert.deepEqual([...first.pruned].sort(), [...second.pruned].sort());
  assert.equal(first.pruned.length, 2);
});

test("TOG-5740: malformed planner inputs fail closed with typed errors", () => {
  assert.throws(() => planSnapshotPrune(null), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([], null), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([{ name: "snapshot-a.json" }]), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([{ mtimeMs: 1 }]), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([], { keepLast: 0, now: NOW }), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([], { keepLast: 1.5, now: NOW }), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([], { maxAgeDays: -1, now: NOW }), SnapshotPruneError);
  assert.throws(() => planSnapshotPrune([], { now: "not-a-date" }), SnapshotPruneError);
});

test("TOG-5740: prune CLI dry-run lists without deleting", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wayselect-prune-dry-"));
  try {
    const aged = snapshotFiles(5, { startAgeDays: 40, stepDays: 5 });
    await stageScratchFiles(dir, [...snapshotFiles(10), ...aged]);
    await fs.writeFile(join(dir, "diff-report-old-vs-new.md"), "# diff\n");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect-snapshot-prune",
        "--dir",
        dir,
        "--keep-last",
        "10",
        "--max-age-days",
        "30",
        "--now",
        new Date(NOW).toISOString(),
      ],
      { cwd: repoRoot },
    );
    assert.equal(stderr, "");
    const plan = JSON.parse(stdout);
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.deleted, []);
    assert.equal(plan.pruned.length, 5);
    assert.equal(plan.kept.length, 10);
    assert.deepEqual(plan.skipped, ["diff-report-old-vs-new.md"]);

    const remaining = await fs.readdir(dir);
    assert.equal(remaining.length, 16, "dry-run must delete nothing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TOG-5740: prune CLI --apply deletes only old overflow on scratch copies", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "wayselect-prune-apply-"));
  try {
    const young = snapshotFiles(10);
    const aged = snapshotFiles(3, { startAgeDays: 40, stepDays: 5 });
    await stageScratchFiles(dir, [...young, ...aged]);
    await fs.writeFile(join(dir, "sample-diff-with-changes.md"), "# diff\n");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect-snapshot-prune",
        "--dir",
        dir,
        "--keep-last",
        "10",
        "--max-age-days",
        "30",
        "--now",
        new Date(NOW).toISOString(),
        "--apply",
      ],
      { cwd: repoRoot },
    );
    assert.equal(stderr, "");
    const plan = JSON.parse(stdout);
    assert.equal(plan.dryRun, false);
    assert.deepEqual(plan.pruned, []);
    assert.deepEqual(
      [...plan.deleted].sort(),
      aged.map((entry) => entry.name).sort(),
    );

    const remaining = await fs.readdir(dir);
    assert.equal(remaining.length, 11, "10 kept snapshots + 1 skipped report");
    assert.ok(remaining.includes("sample-diff-with-changes.md"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TOG-5740: prune CLI rejects usage errors with exit 2", async () => {
  async function runCli(args) {
    try {
      await execFileAsync(process.execPath, ["bin/wayselect-snapshot-prune", ...args], {
        cwd: repoRoot,
      });
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: error.code, stderr: String(error.stderr ?? "") };
    }
  }

  for (const args of [
    ["--bogus"],
    ["--keep-last"],
    ["--keep-last", "0"],
    ["--max-age-days", "-1"],
    ["--now", "not-a-date"],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, 2, `--apply ${args.join(" ")} must exit 2`);
    assert.match(result.stderr, /Usage: node bin\/wayselect-snapshot-prune/);
  }
});

test("TOG-5740: planner defaults keep ten snapshots for thirty days", () => {
  assert.equal(DEFAULT_KEEP_LAST, 10);
  assert.equal(DEFAULT_MAX_AGE_DAYS, 30);
});
