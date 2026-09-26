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

export const evaluationOptions = Object.freeze({
  now: new Date("2026-09-24T12:00:00.000Z"),
  maxEvidenceAgeMs: 72 * 60 * 60 * 1000,
});
