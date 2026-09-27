// TOG-6722 (Gap R4-16): non-finite/negative maxCatalogAgeMs fail-closed pin
// (test-only).
//
// Exact behavior pinned against `src/freshness.js`
// (`normalizeMaxCatalogAgeMs`) and `src/eligibility.js`
// (`normalizeOptions`): any `maxCatalogAgeMs` that is not a finite
// non-negative number (-1, NaN, Infinity) is rejected at the boundary with
// a typed error — never treated as "no limit" and never coerced. A negative
// or NaN budget must not silently pass a stale catalog as fresh, and
// Infinity must not silently disable the staleness gate.
//
// Each case asserts the rejection at all three library entry points that
// accept the budget: `checkCatalogFreshness` (probe), `requireFreshCatalog`
// (hard gate), and `evaluateEligibility` (routing). If any boundary stops
// throwing, file a bug card instead of silently updating the expectation.
//
// node:test, zero dependencies beyond the repo's own src/ modules. No
// network. Refresh-proof clock: `now` sits one hour after the live fixture
// snapshot, so provenance refreshes never break these tests (the budget is
// rejected before the snapshot age is even compared).

import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogFreshnessError,
  checkCatalogFreshness,
  EligibilityRequestError,
  evaluateEligibility,
  requireFreshCatalog,
} from "../src/index.js";
import {
  evaluationOptions,
  loadConfiguredCandidates,
} from "../support/helpers.js";

const defaultRequest = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

async function freshArgs() {
  const { catalog, candidates } = await loadConfiguredCandidates();
  const now = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + 60 * 60 * 1000,
  );
  return { catalog, candidates, now };
}

const INVALID_BUDGETS = [
  ["negative (-1)", -1],
  ["NaN", Number.NaN],
  ["Infinity", Infinity],
];

for (const [label, maxCatalogAgeMs] of INVALID_BUDGETS) {
  test(`TOG-6722: ${label} maxCatalogAgeMs fails closed at every freshness boundary`, async () => {
    const { catalog, candidates, now } = await freshArgs();

    assert.throws(
      () => checkCatalogFreshness(catalog, { now, maxCatalogAgeMs }),
      (error) =>
        error instanceof CatalogFreshnessError &&
        /maxCatalogAgeMs must be a non-negative number/.test(error.message),
      `${label}: probe must reject the budget`,
    );

    assert.throws(
      () => requireFreshCatalog(catalog, { now, maxCatalogAgeMs }),
      CatalogFreshnessError,
      `${label}: hard gate must reject the budget`,
    );

    assert.throws(
      () =>
        evaluateEligibility(candidates, defaultRequest, {
          ...evaluationOptions,
          catalog,
          maxCatalogAgeMs,
        }),
      (error) =>
        error instanceof EligibilityRequestError &&
        /maxCatalogAgeMs must be a non-negative number/.test(error.message),
      `${label}: routing must reject the budget`,
    );
  });
}
