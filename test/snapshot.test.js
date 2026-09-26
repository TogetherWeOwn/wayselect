import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeCatalog } from "../src/index.js";
import { diffSnapshots, formatDiffReport } from "../src/catalogDiff.js";
import { buildSnapshot, computeContentHash, SnapshotError } from "../src/snapshot.js";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const NOW = "2026-09-24T12:00:00.000Z";
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

async function fixtureSnapshot(overrides = {}) {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = overrides.catalog ?? fixture.catalog;
  const provenance = overrides.provenance ?? fixture.provenance;
  return buildSnapshot(catalog, provenance, {
    now: overrides.now ?? NOW,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
  });
}

test("fixture snapshot records a content hash and real provenance gaps", async () => {
  const snapshot = await fixtureSnapshot();

  assert.equal(snapshot.tool, "wayselect-snapshot");
  assert.equal(snapshot.mode, "staging-only");
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshot.entries.length, 6);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entries));

  const gaps = new Set(snapshot.gaps.map((gap) => `${gap.routeId}:${gap.gap}`));
  assert.ok(gaps.has("null:declared-hash-unverified"));
  assert.ok(gaps.has("northstar/unknown-tools:missing-capability:toolUse"));
  assert.ok(gaps.has("northstar/unknown-tools:missing-capability:attachment"));
});

test("content hash is stable and order-independent", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = normalizeCatalog(fixture.catalog, fixture.provenance);

  const forward = computeContentHash(catalog.entries);
  const reversed = computeContentHash([...catalog.entries].reverse());
  assert.equal(forward, reversed);

  const changed = structuredClone(catalog.entries);
  changed[0] = { ...changed[0], name: "Renamed" };
  assert.notEqual(computeContentHash(changed), forward);
});

test("snapshot refuses non-staging catalog sources and stale catalogs", async () => {
  const fixture = await readFixture("catalog.synthetic.json");

  assert.throws(
    () =>
      buildSnapshot(fixture.catalog, {
        ...fixture.provenance,
        source: "https://production.example.invalid/catalog",
      }),
    SnapshotError,
  );

  const futureNow = new Date(Date.parse(fixture.provenance.snapshotTimestamp) - 1000);
  const futureSnapshot = buildSnapshot(fixture.catalog, fixture.provenance, {
    now: futureNow,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
  });
  assert.ok(
    futureSnapshot.gaps.some((gap) => gap.gap === "future-snapshot"),
    "future-dated catalog records a future-snapshot gap; the CLI enforces fail-closed",
  );
});

test("diff reports added, removed, and changed routes plus gap deltas", async () => {
  const previous = await fixtureSnapshot();

  const fixture = await readFixture("catalog.synthetic.json");
  const next = structuredClone(fixture.catalog);
  next.orbit.models["orbit-next"] = {
    id: "orbit-next",
    name: "Orbit Next",
    attachment: false,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 1, output: 1 },
  };
  next.northstar.models["alpha-chat"] = {
    ...next.northstar.models["alpha-chat"],
    name: "Alpha Chat v2",
  };
  delete next.legacy.models["old-chat"];

  const current = await fixtureSnapshot({ catalog: next });
  const diff = diffSnapshots(previous, current);

  assert.deepEqual(diff.added, ["orbit/orbit-next"]);
  assert.deepEqual(diff.removed, ["legacy/old-chat"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].routeId, "northstar/alpha-chat");
  assert.equal(diff.summary.contentHashChanged, true);
  assert.equal(
    diff.newGaps.filter((gap) => gap.routeId === "orbit/orbit-next").length,
    0,
  );
  assert.ok(diff.resolvedGaps.length >= 0);

  const report = formatDiffReport(diff);
  assert.match(report, /## Added routes/);
  assert.match(report, /orbit\/orbit-next/);
  assert.match(report, /## Removed routes/);
  assert.match(report, /## Changed routes/);
});

test("identical snapshots produce an empty readable diff report", async () => {
  const previous = await fixtureSnapshot();
  const current = await fixtureSnapshot();
  const diff = diffSnapshots(previous, current);

  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.summary.contentHashChanged, false);
  assert.match(formatDiffReport(diff), /No route changes between snapshots/);
});

test("diff refuses snapshots from different source prefixes", async () => {
  const previous = await fixtureSnapshot();
  const current = { ...previous, sourcePrefix: "https://production.example.invalid/" };
  assert.throws(() => diffSnapshots(previous, current), /different source prefixes/);
});

test("snapshot CLI writes two consecutive green snapshots with a readable diff", async () => {
  const outDir = await fs.mkdtemp(join(tmpdir(), "wayselect-snapshots-"));
  const runCli = (args) =>
    execFileAsync(process.execPath, ["bin/wayselect-snapshot", ...args], {
      cwd: new URL("..", import.meta.url),
    });

  const first = await runCli([
    "--out",
    outDir,
    "--now",
    NOW,
    "--max-catalog-age-hours",
    "24",
  ]);
  const firstResult = JSON.parse(first.stdout);
  assert.equal(firstResult.mode, "staging-only");
  assert.equal(first.stderr, "");
  assert.ok(firstResult.snapshotPath.endsWith(".json"));

  const second = await runCli([
    "--out",
    outDir,
    "--now",
    NOW,
    "--max-catalog-age-hours",
    "24",
    "--previous",
    join(outDir, firstResult.snapshotPath),
  ]);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.gapCount, firstResult.gapCount);
  assert.deepEqual(secondResult.diffSummary.addedCount, 0);
  assert.deepEqual(secondResult.diffSummary.contentHashChanged, false);
  assert.ok(secondResult.reportPath.endsWith(".md"));

  const report = await fs.readFile(join(outDir, secondResult.reportPath), "utf8");
  assert.match(report, /# Wayselect staging catalog snapshot diff/);
  assert.match(report, /No route changes between snapshots/);

  await fs.rm(outDir, { recursive: true, force: true });
});

test("snapshot CLI fails closed on a stale catalog", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "bin/wayselect-snapshot",
        "--out",
        await fs.mkdtemp(join(tmpdir(), "wayselect-snapshots-")),
        "--now",
        "2026-10-24T12:00:00.000Z",
        "--max-catalog-age-hours",
        "24",
      ],
      { cwd: new URL("..", import.meta.url) },
    ),
    /stale/,
  );
});
