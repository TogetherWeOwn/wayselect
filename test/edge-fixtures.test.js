import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applySupportConfiguration,
  normalizeCatalog,
  selectRoute,
} from "../src/index.js";
import { loadConfiguredCandidates } from "../support/helpers.js";

// TOG-4800: drives the synthetic edge corpus in fixtures/edges/ through the
// real normalize -> configure -> select pipeline. Fixtures with
// "configuration": null use the default demo configuration; the others carry
// their own configuration override. Catalog-error fixtures carry a raw catalog
// + provenance instead and must fail closed at the boundary.
//
// TOG-5265 port notes (current main):
// - selectRoute requires options.catalog for freshness enforcement (TOG-5299),
//   so the normalized catalog is threaded through with an explicit
//   maxCatalogAgeMs. Edges default to 24h; stale-evidence.json carries its own
//   maxCatalogAgeHours so the catalog gate stays fresh and evidence staleness
//   is the gate that fails closed.
// - Catalog-error fixtures carry real snapshot hashes: main verifies the hash
//   before field validation, so placeholder hashes would trip integrity
//   instead of the documented CatalogValidationError.

async function readEdge(name) {
  return JSON.parse(
    await readFile(new URL(`../fixtures/edges/${name}`, import.meta.url), "utf8"),
  );
}

async function runSelectionEdge(name) {
  const edge = await readEdge(name);
  const { catalog, candidates: defaultCandidates } =
    await loadConfiguredCandidates();
  const candidates = edge.configuration
    ? applySupportConfiguration(catalog, edge.configuration)
    : defaultCandidates;
  const result = selectRoute(candidates, edge.selection, {
    now: new Date(edge.evaluationTime),
    maxEvidenceAgeMs: edge.maxEvidenceAgeHours * 60 * 60 * 1000,
    catalog,
    maxCatalogAgeMs: (edge.maxCatalogAgeHours ?? 24) * 60 * 60 * 1000,
  });
  return { edge, result };
}

function reasonsByRoute(result) {
  return new Map(result.candidates.map((candidate) => [candidate.routeId, candidate.reasons]));
}

for (const name of [
  "tie-break.json",
  "no-eligible-route.json",
  "disallowed-provider.json",
  "unsupported-operation.json",
  "stale-evidence.json",
  "missing-evidence.json",
]) {
  test(`edge fixture ${name} selects or fails closed as documented`, async () => {
    const { edge, result } = await runSelectionEdge(name);

    assert.equal(result.status, edge.expect.status);
    assert.equal(result.dryRun, true);
    assert.equal(result.selected?.routeId ?? null, edge.expect.selectedRouteId);

    const byRoute = reasonsByRoute(result);
    for (const [routeId, fragments] of Object.entries(edge.expect.reasonIncludes ?? {})) {
      assert.ok(byRoute.has(routeId), `expected candidate ${routeId} in output`);
      for (const fragment of fragments) {
        assert.ok(
          byRoute.get(routeId).some((reason) => reason.includes(fragment)),
          `${routeId} reasons ${JSON.stringify(byRoute.get(routeId))} include ${fragment}`,
        );
      }
    }

    if (edge.expect.status === "selected") {
      assert.ok(result.selected, "selected status must carry a selected candidate");
      assert.deepEqual(result.selected.reasons, []);
    } else {
      assert.equal(result.selected, null);
      assert.ok(
        result.candidates.every((candidate) => !candidate.eligible),
        "no-eligible-route must leave zero eligible candidates",
      );
    }
  });
}

test("edge fixture tie-break.json is a genuine rate tie on lexicographic order", async () => {
  const { edge, result } = await runSelectionEdge("tie-break.json");

  const tied = result.candidates.filter(
    (candidate) =>
      candidate.eligible &&
      candidate.rates.inputPerMillion + candidate.rates.outputPerMillion ===
        edge.expect.tiedEstimatedRatePerMillion,
  );
  assert.deepEqual(
    tied.map((candidate) => candidate.routeId).sort(),
    [...edge.expect.tiedRouteIds].sort(),
  );
  assert.equal(result.selected.routeId, edge.expect.selectedRouteId);
  assert.equal(
    result.selected.routeId,
    [...edge.expect.tiedRouteIds].sort()[0],
    "the lexicographically smallest tied route id wins",
  );
});

test("edge fixture missing-evidence.json fails closed without guessing", async () => {
  const { result } = await runSelectionEdge("missing-evidence.json");
  const candidate = result.candidates.find(
    (entry) => entry.routeId === "northstar/alpha-chat",
  );

  assert.ok(candidate, "alpha-chat must be present in the output");
  assert.equal(candidate.eligible, false);
  assert.ok(candidate.reasons.includes("missing-evidence"));
});

for (const [name, errorName] of [
  ["malformed-catalog-entry.json", "CatalogValidationError"],
  ["unknown-field-catalog-entry.json", "CatalogValidationError"],
]) {
  test(`edge fixture ${name} is rejected fail-closed at the catalog boundary`, async () => {
    const edge = await readEdge(name);

    assert.equal(edge.expect.errorName, errorName);
    assert.throws(
      () => normalizeCatalog(edge.catalog, edge.provenance),
      (error) =>
        error.name === errorName && new RegExp(edge.expect.messageMatch).test(error.message),
    );
  });
}
