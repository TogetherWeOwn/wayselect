import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeCatalog } from "../src/index.js";
import {
  SearchIndexError,
  buildSearchIndex,
  createRefreshQueue,
  probeSearchIndexRefresh,
  reloadSearchIndex,
} from "../src/searchIndex.js";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const NOW = "2026-09-24T12:00:00.000Z";
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

async function fixtureParts() {
  const fixture = await readFixture("catalog.synthetic.json");
  return { catalog: fixture.catalog, provenance: fixture.provenance };
}

test("TOG-5460: build covers every catalog route with frozen entries", async () => {
  const { catalog, provenance } = await fixtureParts();
  const index = buildSearchIndex(catalog, provenance, { now: NOW, maxCatalogAgeMs: MAX_CATALOG_AGE_MS });

  assert.equal(index.tool, "wayselect-search-index");
  assert.equal(index.mode, "fixture-only");
  assert.match(index.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(index.entries.length, 6);
  assert.ok(Object.isFrozen(index));
  assert.ok(Object.isFrozen(index.entries));

  const catalogRoutes = new Set(
    normalizeCatalog(catalog, provenance).entries.map((entry) => entry.routeId),
  );
  const indexRoutes = new Set(index.entries.map((entry) => entry.routeId));
  assert.deepEqual([...indexRoutes].sort(), [...catalogRoutes].sort());

  const alpha = index.entries.find((entry) => entry.routeId === "northstar/alpha-chat");
  assert.ok(alpha.searchText.includes("alpha chat"));
  assert.ok(alpha.searchText.includes("northstar/alpha-chat"));
  assert.equal(index.freshness.fresh, true);
});

test("TOG-5460: consecutive builds agree; reload is a no-op", async () => {
  const { catalog, provenance } = await fixtureParts();
  const options = { now: NOW, maxCatalogAgeMs: MAX_CATALOG_AGE_MS };
  const first = buildSearchIndex(catalog, provenance, options);
  const second = buildSearchIndex(catalog, provenance, options);
  assert.equal(second.contentHash, first.contentHash);

  const reload = reloadSearchIndex(first, catalog, provenance, options);
  assert.equal(reload.changed, false);
  assert.equal(reload.contentHash, first.contentHash);
  assert.deepEqual(reload.index.entries, first.entries);
});

test("TOG-5460: reload reports changed when the catalog body moves", async () => {
  const { catalog, provenance } = await fixtureParts();
  const options = { now: NOW, maxCatalogAgeMs: MAX_CATALOG_AGE_MS };
  const before = buildSearchIndex(catalog, provenance, options);

  const next = structuredClone(catalog);
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
  const { computeCatalogSnapshotHash } = await import("../src/index.js");
  const reload = reloadSearchIndex(
    before,
    next,
    { ...provenance, snapshotHash: computeCatalogSnapshotHash(next) },
    options,
  );
  assert.equal(reload.changed, true);
  assert.equal(reload.previousContentHash, before.contentHash);
  assert.equal(reload.index.entries.length, 7);
});

test("TOG-5460: queue dedups identical pending jobs, drains in order", async () => {
  const { catalog, provenance } = await fixtureParts();
  const queue = createRefreshQueue();
  const first = queue.enqueue(catalog, provenance, { now: NOW });
  const duplicate = queue.enqueue(catalog, provenance, { now: NOW });
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(queue.pendingCount(), 1);

  const results = queue.drain();
  assert.equal(results.length, 1);
  assert.equal(results[0].jobId, first.jobId);
  assert.equal(results[0].routeCount, 6);
  assert.equal(queue.pendingCount(), 0);

  // Draining again with the same fixture refresh is changed:false.
  queue.enqueue(catalog, provenance, { now: NOW });
  const again = queue.drain();
  assert.equal(again.length, 1);
  assert.equal(again[0].changed, false);
  assert.ok(queue.currentIndex() !== null);
});

test("TOG-5460: non-staging sources are refused", async () => {
  const { catalog, provenance } = await fixtureParts();
  assert.throws(
    () =>
      buildSearchIndex(catalog, {
        ...provenance,
        source: "https://production.example.invalid/catalog",
      }),
    SearchIndexError,
  );
  assert.throws(() => reloadSearchIndex(null, catalog, provenance), SearchIndexError);
  assert.throws(
    () => buildSearchIndex(catalog, provenance, { sourcePrefix: "" }),
    SearchIndexError,
  );
});

test("TOG-5460: refresh probe passes green on fixtures, flags tampering", async () => {
  const { catalog, provenance } = await fixtureParts();
  const green = probeSearchIndexRefresh(catalog, provenance, {
    now: NOW,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
  });
  assert.equal(green.ok, true);
  assert.deepEqual(
    green.checks.map((entry) => entry.id),
    ["R1-source", "R2-parity", "R3-stable", "R4-idempotent", "R5-fresh"],
  );
  assert.ok(green.checks.every((entry) => entry.ok));

  const bad = probeSearchIndexRefresh(
    { ...catalog, northstar: { ...catalog.northstar, models: {} } },
    provenance,
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.some((entry) => entry.ok === false));
});

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [args[0], ...args.slice(1)], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("TOG-5460: CLI --check probe passes twice consecutively (done criteria)", async () => {
  const args = [
    "bin/wayselect-search-index-refresh",
    "--check",
    "--now",
    NOW,
    "--max-catalog-age-hours",
    "24",
  ];
  const first = await runCli(args);
  const second = await runCli(args);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.match(first.stdout, /refresh-probe: 5\/5 checks passed/);
  assert.match(second.stdout, /refresh-probe: 5\/5 checks passed/);
  const firstHash = first.stdout.match(/content (sha256:[a-f0-9]{64})/)?.[1];
  const secondHash = second.stdout.match(/content (sha256:[a-f0-9]{64})/)?.[1];
  assert.ok(firstHash);
  assert.equal(secondHash, firstHash);
});

test("TOG-5460: CLI refresh writes the index and reloads idempotently", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-search-index-"));
  try {
    const outDir = join(base, "out");
    const first = await runCli([
      "bin/wayselect-search-index-refresh",
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(first.code, 0);
    const payload = JSON.parse(first.stdout);
    assert.equal(payload.mode, "fixture-only");
    assert.equal(payload.networkUsed, false);
    assert.equal(payload.routeCount, 6);
    assert.equal(payload.reloadChanged, false);
    assert.match(payload.contentHash, /^sha256:[a-f0-9]{64}$/);

    const names = await fs.readdir(outDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^search-index-.*-[a-f0-9]{8}\.json$/);
    const stored = JSON.parse(await fs.readFile(join(outDir, names[0]), "utf8"));
    assert.equal(stored.contentHash, payload.contentHash);

    // Same-input rerun over --previous reports changed:false.
    const second = await runCli([
      "bin/wayselect-search-index-refresh",
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
      "--previous",
      join(outDir, names[0]),
    ]);
    assert.equal(second.code, 0);
    assert.equal(JSON.parse(second.stdout).changedVsPrevious, false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("TOG-5460: CLI stale catalog fails closed and writes no file", async () => {
  const outDir = join(await fs.mkdtemp(join(tmpdir(), "wayselect-search-index-")), "out");
  try {
    const result = await runCli([
      "bin/wayselect-search-index-refresh",
      "--out",
      outDir,
      "--now",
      "2026-10-24T12:00:00.000Z",
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Error: refusing stale staging snapshot: age 2599200000ms exceeds limit 86400000ms\n",
    );
    assert.deepEqual(await fs.readdir(outDir).catch(() => []), []);
  } finally {
    await fs.rm(join(outDir, ".."), { recursive: true, force: true });
  }
});
