import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  applySupportConfiguration,
  normalizeCatalog,
} from "../src/index.js";

export async function readFixture(name) {
  return JSON.parse(
    await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  );
}

export async function loadConfiguredCandidates() {
  const [catalogFixture, configuration] = await Promise.all([
    readFixture("catalog.synthetic.json"),
    readFixture("configuration.synthetic.json"),
  ]);
  const catalog = normalizeCatalog(catalogFixture.catalog, catalogFixture.provenance);
  return {
    catalog,
    candidates: applySupportConfiguration(catalog, configuration),
  };
}

// Evaluation clock derived from the live catalog snapshot so the suite stays
// green across provenance refreshes: evaluation sits two hours after the
// snapshot, matching the recorded QA scenario distance. Sync read keeps the
// helper usable from both sync and async test contexts.
export function evaluationNow() {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  return new Date(Date.parse(fixture.provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000);
}

// TOG-5299: these unit options intentionally exercise the non-catalog gates
// (capabilities, evidence, providers), so they carry the explicit catalog
// opt-out rather than silently skipping freshness enforcement.
export const evaluationOptions = Object.freeze({
  get now() {
    return evaluationNow();
  },
  maxEvidenceAgeMs: 72 * 60 * 60 * 1000,
  skipCatalogCheck: true,
});
