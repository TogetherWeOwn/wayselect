// TOG-6336 (TOG-5735 impl slice): large-catalog stress fixture + refresh
// benchmark budget.
//
// What: builds the deterministic 2000-route fixture in memory (via
// generateLargeCatalog, same bytes as fixtures/catalog.large-synthetic.json),
// then times each perf path — normalizeCatalog, buildSearchIndex,
// probeSearchIndexRefresh, buildSnapshot x2 (with a small delta), and
// diffSnapshots — asserting each stays under its budget.
//
// Margin rationale: measured maxima on current main are normalize ~22ms,
// searchIndex ~33ms, probe ~114ms, snapshot ~62ms (x2 in one stage),
// diff ~9ms; budgets are ~8-10x those maxima rounded to clean numbers, so
// normal CI timer variance
// (2-3x) stays green while a real regression (algorithmic blowup, accidental
// N^2) trips loudly. No control delay needed at this scale: unlike the
// sub-millisecond TOG-6036 select, halving any budget here still passes on
// healthy code but the stages are slow enough that a genuine regression
// exceeds the 10x headroom.
//
// Runbook (when this trips): run `npm run bench:large-catalog` to see which
// stage regressed, bisect recent catalog/searchIndex/snapshot/catalogDiff
// changes, profile that stage on the fixture — do NOT raise the budget without
// recording a perf explanation on the card.
// Test/CI-only, no prod activation.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  computeCatalogSnapshotHash,
  normalizeCatalog,
} from "../src/index.js";
import { buildSearchIndex, probeSearchIndexRefresh } from "../src/index.js";
import { buildSnapshot } from "../src/index.js";
import { diffSnapshots } from "../src/index.js";
import { LARGE_CATALOG_BUDGETS_MS } from "../bin/benchmark-large-catalog";
import { generateLargeCatalog } from "../scripts/generate-large-catalog.mjs";

const FIXTURE_URL = new URL("../fixtures/catalog.large-synthetic.json", import.meta.url);

function timed(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  return { result, elapsedMs: Number(process.hrtime.bigint() - start) / 1e6 };
}

function assertUnderBudget(stage, elapsedMs) {
  const budget = LARGE_CATALOG_BUDGETS_MS[stage];
  assert.ok(
    elapsedMs < budget,
    `Large-catalog perf regression: ${stage} took ${elapsedMs.toFixed(1)}ms, ` +
      `budget ${budget}ms. Runbook: run npm run bench:large-catalog, bisect ` +
      `recent catalog/searchIndex/snapshot changes, profile — do not raise ` +
      `the budget without a recorded perf explanation.`,
  );
}

test("large-catalog fixture determinism + stage budgets (TOG-6336)", () => {
  const generated = generateLargeCatalog();
  assert.equal(generated.routeCount, 2000, "fixture must hold 2000 routes");

  const normalized = timed(() =>
    normalizeCatalog(generated.catalog, generated.provenance),
  );
  assert.equal(normalized.result.entries.length, 2000);
  assertUnderBudget("normalize", normalized.elapsedMs);

  const indexed = timed(() =>
    buildSearchIndex(generated.catalog, generated.provenance),
  );
  assert.equal(indexed.result.entries.length, 2000);
  assertUnderBudget("searchIndex", indexed.elapsedMs);

  const probed = timed(() =>
    probeSearchIndexRefresh(generated.catalog, generated.provenance),
  );
  assert.equal(probed.result.ok, true, "probe checks must hold on the fixture");
  assertUnderBudget("probe", probed.elapsedMs);

  const deltaCatalog = structuredClone(generated.catalog);
  const providerIds = Object.keys(deltaCatalog).sort();
  const firstProvider = deltaCatalog[providerIds[0]];
  const firstModelId = Object.keys(firstProvider.models).sort()[0];
  firstProvider.models[firstModelId] = {
    ...firstProvider.models[firstModelId],
    name: `${firstProvider.models[firstModelId].name} (delta)`,
  };
  const lastProvider = deltaCatalog[providerIds[providerIds.length - 1]];
  lastProvider.models["stress-model-delta"] = {
    id: "stress-model-delta",
    name: "Delta Model",
    attachment: false,
    reasoning: false,
    tool_call: true,
    structured_output: false,
    modalities: { input: ["text"], output: ["text"] },
    context_window: 32768,
    max_output_tokens: 4096,
    cost: { input: 1, output: 2 },
  };
  const deltaProvenance = {
    ...generated.provenance,
    snapshotHash: computeCatalogSnapshotHash(deltaCatalog),
  };

  const snapshotted = timed(() => ({
    base: buildSnapshot(generated.catalog, generated.provenance),
    next: buildSnapshot(deltaCatalog, deltaProvenance),
  }));
  assertUnderBudget("snapshot", snapshotted.elapsedMs);

  const diffed = timed(() =>
    diffSnapshots(snapshotted.result.base, snapshotted.result.next),
  );
  assert.equal(diffed.result.summary.addedCount, 1);
  assert.equal(diffed.result.summary.changedCount, 1);
  assertUnderBudget("diff", diffed.elapsedMs);
});

test("checked-in large fixture matches the generator (TOG-6336)", async () => {
  const checkedIn = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const generated = generateLargeCatalog();
  assert.equal(
    checkedIn.provenance.snapshotHash,
    generated.provenance.snapshotHash,
    "regenerate with node scripts/generate-large-catalog.mjs — never hand-edit",
  );
  assert.deepEqual(Object.keys(checkedIn.catalog).sort(), Object.keys(generated.catalog).sort());
});
