import test from "node:test";
import assert from "node:assert/strict";
import {
  SupportConfigurationError,
  applySupportConfiguration,
  normalizeCatalog,
} from "../src/index.js";
import { readFixture } from "../support/helpers.js";

async function loadCatalog() {
  const fixture = await readFixture("catalog.synthetic.json");
  return normalizeCatalog(fixture.catalog, fixture.provenance);
}

test("keeps uncited catalog entries catalogued rather than executable", async () => {
  const catalog = await loadCatalog();
  const candidates = applySupportConfiguration(catalog, { candidates: [] });

  assert.ok(candidates.every((candidate) => candidate.supportState === "catalogued"));
  assert.ok(candidates.every((candidate) => candidate.configuredOperations.length === 0));
});

test("rejects configuration for a route that is absent from the catalog", async () => {
  const catalog = await loadCatalog();

  assert.throws(
    () =>
      applySupportConfiguration(catalog, {
        candidates: [
          {
            routeId: "unknown/model",
            supportState: "configured",
            operations: ["chat"],
            evidence: { observedAt: "2026-09-24T00:00:00.000Z" },
          },
        ],
      }),
    SupportConfigurationError,
  );
});

test("malformed catalog input fails closed with SupportConfigurationError", async () => {
  assert.throws(
    () => applySupportConfiguration(null, { candidates: [] }),
    /catalog.entries must be an array/,
  );
  assert.throws(
    () => applySupportConfiguration({ entries: "nope" }, { candidates: [] }),
    /catalog.entries must be an array/,
  );
});

test("explicit null operations fail closed instead of defaulting to empty", async () => {
  const catalog = await loadCatalog();

  assert.throws(
    () =>
      applySupportConfiguration(catalog, {
        candidates: [
          {
            routeId: "northstar/alpha-chat",
            supportState: "configured",
            operations: null,
          },
        ],
      }),
    SupportConfigurationError,
  );
});

test("requires explicit operations for configured support", async () => {
  const catalog = await loadCatalog();

  assert.throws(
    () =>
      applySupportConfiguration(catalog, {
        candidates: [
          {
            routeId: "northstar/alpha-chat",
            supportState: "configured",
            operations: [],
          },
        ],
      }),
    /operations must not be empty/,
  );
});

test("malformed catalog entries fail closed with SupportConfigurationError", async () => {
  const catalog = await loadCatalog();

  assert.throws(
    () => applySupportConfiguration({ entries: [null] }, { candidates: [] }),
    SupportConfigurationError,
  );
  assert.throws(
    () => applySupportConfiguration({ entries: [{}] }, { candidates: [] }),
    SupportConfigurationError,
  );
  assert.throws(
    () =>
      applySupportConfiguration(
        { entries: [catalog.entries[0], catalog.entries[0]] },
        { candidates: [] },
      ),
    SupportConfigurationError,
  );
});
