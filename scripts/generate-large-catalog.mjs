#!/usr/bin/env node
// TOG-6336 (TOG-5735 impl slice): deterministic large-catalog stress fixture
// generator.
//
// Writes fixtures/catalog.large-synthetic.json: ~50 providers x ~40 models
// (~2000 routes) of synthetic-only catalog data for the refresh benchmark
// budget (test/large-catalog-benchmark.test.js, bin/benchmark-large-catalog).
//
// Deterministic: fixed mulberry32 seed, fixed snapshotTimestamp, fixed
// iteration order — re-running is byte-identical. Never hand-edit the output;
// regenerate with `node scripts/generate-large-catalog.mjs [--out <path>]`.
//
// Stdlib only, no network, no credentials. provenance.source is synthetic://
// so the staging-only boundaries (normalizeCatalog hash verify,
// buildSearchIndex source-prefix gate, buildSnapshot staging gate) accept it,
// and snapshotHash is computed via computeCatalogSnapshotHash so
// normalizeCatalog verifies.
//
// Gap mix (deterministic by route index) exercises fail-closed paths:
//   - every 10th route omits all capability booleans (missing-capability gaps)
//   - every 10th route offset by 1 omits cost (missing-rates gap)
//   - every 10th route offset by 2 omits limits (unknown-limits path)
//   - every 7th route uses image input (vision-chat catalog operation)
//   - varied context_window / max_output_tokens elsewhere

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCatalogSnapshotHash } from "../src/catalog.js";

export const LARGE_FIXTURE_SEED = 5735;
export const LARGE_FIXTURE_SOURCE = "synthetic://wayselect/large-fixture-v1";
export const LARGE_FIXTURE_TIMESTAMP = "2026-09-26T14:00:00.000Z";
export const LARGE_FIXTURE_PROVIDERS = 50;
export const LARGE_FIXTURE_MODELS_PER_PROVIDER = 40;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, "..", "fixtures", "catalog.large-synthetic.json");

// mulberry32: small deterministic PRNG; fixed seed => fixed fixture bytes.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const CAPABILITY_SETS = ["text", "text-image"];

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function buildModel(rand, providerId, modelIndex, routeIndex) {
  const modelId = `stress-model-${String(modelIndex).padStart(2, "0")}`;
  const model = {
    id: modelId,
    name: `Stress Model ${providerId} ${modelIndex}`,
  };

  // Capability gap mix: omit booleans on every 10th route so
  // findEntryGaps reports missing-capability gaps for it.
  if (routeIndex % 10 !== 0) {
    model.attachment = rand() < 0.4;
    model.reasoning = rand() < 0.5;
    model.tool_call = rand() < 0.7;
    model.structured_output = rand() < 0.5;
  }

  const modalitySet = pick(rand, CAPABILITY_SETS);
  if (routeIndex % 7 === 0) {
    model.modalities = { input: ["image", "text"], output: ["text"] };
  } else if (modalitySet === "text-image") {
    model.modalities = { input: ["text"], output: ["image", "text"] };
  } else {
    model.modalities = { input: ["text"], output: ["text"] };
  }

  // Limits mix: omit on every 10th route offset by 2 (unknown-limits path),
  // otherwise vary sizes.
  if (routeIndex % 10 !== 2) {
    model.context_window = pick(rand, [4096, 32768, 128000, 1000000]);
    model.max_output_tokens = pick(rand, [1024, 4096, 16384, 65536]);
  }

  // Rates gap mix: omit cost on every 10th route offset by 1.
  if (routeIndex % 10 !== 1) {
    model.cost = {
      input: Math.round(rand() * 500) / 100,
      output: Math.round(rand() * 1500) / 100,
    };
  }

  return model;
}

export function generateLargeCatalog({
  seed = LARGE_FIXTURE_SEED,
  providers = LARGE_FIXTURE_PROVIDERS,
  modelsPerProvider = LARGE_FIXTURE_MODELS_PER_PROVIDER,
  source = LARGE_FIXTURE_SOURCE,
  snapshotTimestamp = LARGE_FIXTURE_TIMESTAMP,
} = {}) {
  const rand = mulberry32(seed);
  const catalog = {};
  let routeIndex = 0;
  for (let p = 0; p < providers; p += 1) {
    const providerId = `stress-provider-${String(p).padStart(2, "0")}`;
    const models = {};
    for (let m = 0; m < modelsPerProvider; m += 1, routeIndex += 1) {
      const model = buildModel(rand, providerId, m, routeIndex);
      models[model.id] = model;
    }
    catalog[providerId] = {
      id: providerId,
      name: `Stress Provider ${p}`,
      models,
    };
  }
  const snapshotHash = computeCatalogSnapshotHash(catalog);
  return {
    provenance: { source, snapshotTimestamp, snapshotHash },
    catalog,
    routeCount: routeIndex,
  };
}

function parseOut(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("missing value for --out");
      }
      return resolve(value);
    }
    if (argv[i] === "--help" || argv[i] === "-h") {
      return null;
    }
  }
  return DEFAULT_OUT;
}

function printUsage() {
  console.log("Usage: node scripts/generate-large-catalog.mjs [--out <path>]");
}

// Import-safe: the CLI body runs only when executed directly, so tests can
// import generateLargeCatalog without rewriting the checked-in fixture.
const invokedAsCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  const out = parseOut(process.argv.slice(2));
  if (out === null) {
    printUsage();
    process.exit(0);
  }

  const { provenance, catalog, routeCount } = generateLargeCatalog();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify({ provenance, catalog }, null, 2)}\n`, "utf8");
  console.log(`wrote ${out} (${routeCount} routes, ${provenance.snapshotHash})`);
}
