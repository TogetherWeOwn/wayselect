import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFixture } from "../support/helpers.js";
import {
  compareProbeProvenance,
  diffProbedRoutes,
  extractLiveRoutes,
  fixtureRouteRecord,
  formatProbeReport,
} from "../src/modelsDevProbe.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

function liveInput() {
  return {
    northstar: {
      id: "northstar",
      name: "Northstar",
      models: {
        "alpha-chat": { id: "alpha-chat", name: "Alpha Chat", tool_call: true },
        "image-lite": { id: "image-lite", name: "Image Lite", attachment: true },
      },
    },
    orbit: {
      id: "orbit",
      name: "Orbit",
      models: {
        relay: { id: "relay", name: "Relay" },
      },
    },
  };
}

test("TOG-5551: extractLiveRoutes extracts comparable records and quarantines malformed entries", async () => {
  const { routes, quarantined, providerCount } = extractLiveRoutes(liveInput());

  assert.equal(providerCount, 2);
  assert.equal(routes.size, 3);
  assert.equal(quarantined.length, 0);
  assert.equal(routes.get("northstar/alpha-chat").toolCall, true);
  assert.equal(routes.get("northstar/alpha-chat").attachment, null);
  assert.ok(Object.isFrozen(routes.get("northstar/alpha-chat")));
  assert.ok(Object.isFrozen(quarantined));

  const bad = extractLiveRoutes({
    good: { id: "good", name: "Good", models: { m: { id: "m", name: "M" } } },
    broken: { id: "wrong-id", name: "Broken", models: {} },
    nameless: { id: "nameless", name: "", models: {} },
  });
  assert.equal(bad.routes.size, 1);
  assert.equal(bad.quarantined.length, 2);
  assert.deepEqual(
    bad.quarantined.map((entry) => entry.routeId).sort(),
    ["broken", "nameless"],
  );
});

test("TOG-5551: extractLiveRoutes rejects non-object, empty, and route-less input", async () => {
  assert.throws(() => extractLiveRoutes(null), /must be an object/);
  assert.throws(() => extractLiveRoutes({}), /at least one provider/);
  assert.throws(
    () => extractLiveRoutes({ p: { id: "p", name: "P", models: "nope" } }),
    /no live routes survived/,
  );
});

test("TOG-5551: diffProbedRoutes reports added/removed/changed/unchanged with per-field detail", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const { normalizeCatalog } = await import("../src/index.js");
  const catalog = normalizeCatalog(fixture.catalog, fixture.provenance);

  const live = new Map();
  for (const entry of catalog.entries) {
    live.set(entry.routeId, fixtureRouteRecord(entry));
  }
  // Change one overlapping route, drop one fixture route, add one live route.
  const changedId = "northstar/alpha-chat";
  live.set(changedId, Object.freeze({ ...live.get(changedId), name: "Alpha Chat v2" }));
  const removedId = "legacy/old-chat";
  live.delete(removedId);
  live.set(
    "orbit/brand-new",
    Object.freeze({
      routeId: "orbit/brand-new",
      providerId: "orbit",
      modelId: "brand-new",
      name: "Brand New",
      attachment: null,
      reasoning: null,
      toolCall: null,
      structuredOutput: null,
      modalities: null,
      cost: null,
    }),
  );

  const diff = diffProbedRoutes(catalog.entries, live);
  assert.deepEqual(diff.added, ["orbit/brand-new"]);
  assert.deepEqual(diff.removed, [removedId]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].routeId, changedId);
  assert.equal(diff.changed[0].fields.name, true);
  assert.equal(diff.changed[0].fields.cost, false);
  assert.equal(diff.summary.addedCount, 1);
  assert.equal(diff.summary.removedCount, 1);
  assert.equal(diff.summary.changedCount, 1);
  assert.equal(diff.summary.unchangedCount, catalog.entries.length - 2);
  assert.ok(Object.isFrozen(diff));
});

test("TOG-5551: compareProbeProvenance flags changed source/timestamp/hash fields", async () => {
  const same = compareProbeProvenance(
    { source: "s", snapshotTimestamp: "t", snapshotHash: "h" },
    { source: "s", fetchedAt: "t", rawHash: "h" },
  );
  assert.equal(same.changed, false);

  const drifted = compareProbeProvenance(
    { source: "s", snapshotTimestamp: "t", snapshotHash: "h" },
    { source: "live", fetchedAt: "t2", rawHash: "h2" },
  );
  assert.equal(drifted.changed, true);
  assert.equal(drifted.fields.source.changed, true);
  assert.equal(drifted.fields.timestamp.changed, true);
  assert.equal(drifted.fields.hash.changed, true);
  assert.ok(Object.isFrozen(drifted));
});

test("TOG-5551: formatProbeReport samples lists but keeps exact counts", async () => {
  const added = Array.from({ length: 60 }, (_, index) => `provider/model-${index}`);
  const report = formatProbeReport({
    fetchedAt: "2026-09-27T00:00:00.000Z",
    fetchSource: "file://test",
    rawHash: "sha256:abc",
    fetchDurationMs: 1,
    networkUsed: false,
    fixtureProvenance: { source: "synthetic://x", snapshotTimestamp: "t", snapshotHash: "h" },
    fixtureCount: 6,
    liveProviderCount: 2,
    liveCount: 63,
    quarantined: [],
    freshness: { fresh: true, ageMs: 1000, maxCatalogAgeMs: 86400000 },
    provenance: compareProbeProvenance(
      { source: "a", snapshotTimestamp: "t", snapshotHash: "h" },
      { source: "b", fetchedAt: "t2", rawHash: "h2" },
    ),
    diff: {
      added,
      removed: [],
      changed: [],
      unchanged: ["a/b"],
      summary: {
        fixtureCount: 6,
        liveCount: 63,
        addedCount: 60,
        removedCount: 0,
        changedCount: 0,
        unchangedCount: 1,
      },
    },
  });
  assert.match(report, /added 60, removed 0, changed 0, unchanged 1/);
  assert.match(report, /first 50 shown/);
  assert.equal(report.includes("provider/model-59"), false);
});

test("TOG-5551: probe CLI diffs a saved catalog copy offline with no network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "models-dev-probe-"));
  const fixture = await readFixture("catalog.synthetic.json");
  const inputPath = join(dir, "live.json");
  await writeFile(inputPath, JSON.stringify(fixture.catalog));

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "bin/check-models-dev-freshness",
      "--input",
      inputPath,
      "--now",
      new Date(Date.parse(fixture.provenance.snapshotTimestamp) + 3600000).toISOString(),
    ],
    { cwd: repoRoot },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /diff: added 0, removed 0, changed 0, unchanged 6/);
  assert.match(stdout, /freshness: fresh/);
  assert.match(stdout, /network not used/);
});

test("TOG-5551: probe CLI rejects malformed input with exit 1 and no network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "models-dev-probe-bad-"));
  const badPath = join(dir, "bad.json");
  await writeFile(badPath, "{ not json");

  await assert.rejects(
    () => execFileAsync(process.execPath, ["bin/check-models-dev-freshness", "--input", badPath], { cwd: repoRoot }),
    /not valid JSON/,
  );
});
