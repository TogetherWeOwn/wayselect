// TOG-6728 (R4-22): large-fixture generator determinism pin.
//
// What: `scripts/generate-large-catalog.mjs` claims same seed =>
// byte-identical output. This pins that claim: run `generateLargeCatalog()`
// twice with the fixed seed/time defaults and assert the serialized bytes
// (the exact CLI write format: `JSON.stringify({ provenance, catalog },
// null, 2) + "\n"`) are identical.
//
// Seed knob: `generateLargeCatalog({ seed, snapshotTimestamp, source,
// providers, modelsPerProvider })` defaults to `LARGE_FIXTURE_SEED` (5735)
// and `LARGE_FIXTURE_TIMESTAMP` (`2026-09-26T14:00:00.000Z`). Pass an explicit
// `seed` to regenerate variants; redirect the CLI write with
// `node scripts/generate-large-catalog.mjs [--out <path>]`. Never hand-edit
// `fixtures/catalog.large-synthetic.json` — regenerate it.
//
// Test-only, no prod activation.

import test from "node:test";
import assert from "node:assert/strict";
import {
  generateLargeCatalog,
  LARGE_FIXTURE_SEED,
  LARGE_FIXTURE_SOURCE,
  LARGE_FIXTURE_TIMESTAMP,
} from "../scripts/generate-large-catalog.mjs";

// Mirror the CLI write in scripts/generate-large-catalog.mjs exactly.
function serialize({ provenance, catalog }) {
  return `${JSON.stringify({ provenance, catalog }, null, 2)}\n`;
}

test("large-fixture generator is byte-identical across runs (TOG-6728)", () => {
  const first = serialize(generateLargeCatalog());
  const second = serialize(generateLargeCatalog());
  assert.equal(
    second,
    first,
    "same seed must produce byte-identical output — " +
      "re-run node scripts/generate-large-catalog.mjs and diff to debug",
  );
});

test("explicit seed/time defaults match the implicit defaults (TOG-6728)", () => {
  const implicitBytes = serialize(generateLargeCatalog());
  const explicitBytes = serialize(
    generateLargeCatalog({
      seed: LARGE_FIXTURE_SEED,
      snapshotTimestamp: LARGE_FIXTURE_TIMESTAMP,
    }),
  );
  assert.equal(
    explicitBytes,
    implicitBytes,
    "explicit seed/time knobs must match the defaults they document",
  );
  const { provenance } = generateLargeCatalog();
  assert.equal(
    provenance.snapshotTimestamp,
    LARGE_FIXTURE_TIMESTAMP,
    "snapshotTimestamp must stay pinned so re-runs are byte-identical",
  );
  assert.equal(
    provenance.source,
    LARGE_FIXTURE_SOURCE,
    "synthetic source prefix keeps the staging-only gates accepting the fixture",
  );
});

test("a different seed diverges (TOG-6728)", () => {
  const base = serialize(generateLargeCatalog());
  const other = serialize(generateLargeCatalog({ seed: LARGE_FIXTURE_SEED + 1 }));
  assert.notEqual(other, base, "the seed knob must actually affect the output");
});
