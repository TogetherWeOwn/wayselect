import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogFreshnessError,
  CatalogStaleError,
  checkCatalogFreshness,
  evaluateEligibility,
  requireFreshCatalog,
  selectRoute,
} from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const defaultRequest = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

function catalogOptions(catalog, overrides = {}) {
  return {
    ...evaluationOptions,
    catalog,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
    ...overrides,
  };
}

test("fresh catalog passes the probe and keeps eligibility decisions open", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();

  const probe = checkCatalogFreshness(catalog, catalogOptions(catalog));
  assert.equal(probe.fresh, true);
  assert.equal(probe.snapshotTimestamp, catalog.provenance.snapshotTimestamp);
  assert.ok(Object.isFrozen(probe));

  const evaluations = evaluateEligibility(
    candidates,
    defaultRequest,
    catalogOptions(catalog),
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  assert.equal(byRoute.get("northstar/alpha-chat").eligible, true);
});

test("stale catalog fails closed: every candidate is ineligible", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();
  const staleNow = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + MAX_CATALOG_AGE_MS + 1000,
  );

  const probe = checkCatalogFreshness(catalog, catalogOptions(catalog, { now: staleNow }));
  assert.equal(probe.fresh, false);
  assert.ok(probe.ageMs > MAX_CATALOG_AGE_MS);

  const evaluations = evaluateEligibility(
    candidates,
    defaultRequest,
    catalogOptions(catalog, { now: staleNow }),
  );

  assert.ok(evaluations.length > 0);
  assert.ok(evaluations.every((candidate) => candidate.eligible === false));
  assert.ok(
    evaluations.every((candidate) => candidate.reasons.includes("stale-catalog")),
  );
});

test("stale catalog blocks route selection without choosing a route", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();
  const staleNow = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + MAX_CATALOG_AGE_MS + 1000,
  );

  const result = selectRoute(
    candidates,
    defaultRequest,
    catalogOptions(catalog, { now: staleNow }),
  );

  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.selected, null);
  assert.ok(
    result.candidates.every((candidate) =>
      candidate.reasons.includes("stale-catalog"),
    ),
  );
});

test("requireFreshCatalog throws CatalogStaleError on a stale catalog", async () => {
  const { catalog } = await loadConfiguredCandidates();
  const staleNow = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + MAX_CATALOG_AGE_MS + 1000,
  );

  assert.throws(
    () => requireFreshCatalog(catalog, catalogOptions(catalog, { now: staleNow })),
    (error) =>
      error instanceof CatalogStaleError &&
      error.ageMs > MAX_CATALOG_AGE_MS &&
      error.snapshotTimestamp === catalog.provenance.snapshotTimestamp,
  );
});

test("future-dated catalog snapshot fails closed as future-catalog", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();
  const beforeSnapshot = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) - 1000,
  );

  const probe = checkCatalogFreshness(
    catalog,
    catalogOptions(catalog, { now: beforeSnapshot }),
  );
  assert.equal(probe.fresh, false);

  const evaluations = evaluateEligibility(
    candidates,
    defaultRequest,
    catalogOptions(catalog, { now: beforeSnapshot }),
  );
  assert.ok(evaluations.every((candidate) => candidate.eligible === false));
  assert.ok(
    evaluations.every((candidate) => candidate.reasons.includes("future-catalog")),
  );
});

test("eligibility without a catalog behaves exactly as before", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(candidates, defaultRequest, evaluationOptions);
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));

  assert.equal(byRoute.get("northstar/alpha-chat").eligible, true);
  assert.ok(
    evaluations.every((candidate) => !candidate.reasons.includes("stale-catalog")),
  );
});

test("catalog without an explicit staleness threshold is rejected", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();

  assert.throws(
    () => evaluateEligibility(candidates, defaultRequest, { ...evaluationOptions, catalog }),
    /maxCatalogAgeMs must be a non-negative number/,
  );
  assert.throws(
    () => checkCatalogFreshness(catalog, { now: evaluationOptions.now }),
    CatalogFreshnessError,
  );
});
