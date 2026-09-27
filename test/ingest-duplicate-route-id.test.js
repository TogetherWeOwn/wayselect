// TOG-6718 (Gap R4-12): duplicate routeIds in one ingest feed — policy pin (test-only).
//
// Exact behavior pinned against src/ingest.js + src/catalog.js + src/support.js:
//   1. Duplicate JSON keys inside one provider's `models` object never reach
//      ingest: `JSON.parse` last-wins, so the feed's final spelling is the only
//      entry. Ingest keeps that survivor with zero quarantine entries
//      (last-wins, documented here).
//   2. Two provider/model pairs that stringify to the same routeId (`p` + `a/b`
//      vs `p/a` + `b` → `p/a/b`) are BOTH kept by ingest and normalize (no
//      quarantine, no throw) — but the feed fails closed at the configure
//      boundary: `applySupportConfiguration` throws `SupportConfigurationError`
//      naming the duplicated routeId, so a duplicated feed can never reach
//      selection.
// If either outcome changes, file a bug card instead of silently updating the
// expectation.
//
// node:test, zero dependencies beyond the repo's own src/ modules. No network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  applySupportConfiguration,
  normalizeCatalog,
  SupportConfigurationError,
} from "../src/index.js";
import { ingestModelsDev } from "../src/ingest.js";

const SOURCE = "https://models.dev/api.json";
const SNAPSHOT_TIMESTAMP = "2026-09-24T10:00:00.000Z";

function ingest(input) {
  return ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
}

function textModel(name) {
  return {
    id: "chat-one",
    name,
    modalities: { input: ["text"], output: ["text"] },
  };
}

test("TOG-6718: duplicate JSON keys last-win at parse; ingest keeps the survivor", () => {
  // One raw feed text, two `chat-one` keys: JSON.parse keeps the final
  // spelling ("Second") before ingest ever sees the feed.
  const raw =
    `{"acme":{"id":"acme","name":"A","models":{"chat-one":` +
    `${JSON.stringify(textModel("First"))},"chat-one":` +
    `${JSON.stringify(textModel("Second"))}}}}`;
  const parsed = JSON.parse(raw);
  assert.equal(parsed.acme.models["chat-one"].name, "Second");

  const result = ingest(parsed);
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(Object.keys(result.catalog.acme.models), ["chat-one"]);

  const catalog = normalizeCatalog(result.catalog, result.provenance);
  assert.deepEqual(
    catalog.entries.map((entry) => [entry.routeId, entry.name]),
    [["acme/chat-one", "Second"]],
  );
});

test("TOG-6718: slash-collision duplicates are kept, then fail closed at configure", () => {
  // `p` + `a/b` and `p/a` + `b` stringify to the same routeId `p/a/b`.
  const input = {
    p: {
      id: "p",
      name: "P",
      models: {
        "a/b": {
          id: "a/b",
          name: "First",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
    "p/a": {
      id: "p/a",
      name: "PA",
      models: {
        b: {
          id: "b",
          name: "Second",
          modalities: { input: ["text"], output: ["text"] },
        },
      },
    },
  };

  const result = ingest(input);
  // Ingest and normalize keep both entries silently: no quarantine, no throw.
  assert.deepEqual(result.quarantined, []);
  const catalog = normalizeCatalog(result.catalog, result.provenance);
  assert.deepEqual(
    catalog.entries.map((entry) => [entry.routeId, entry.name]),
    [
      ["p/a/b", "First"],
      ["p/a/b", "Second"],
    ],
  );

  // The feed fails closed at the configure boundary, before selection: no
  // candidate list can be built from a duplicated catalog.
  assert.throws(
    () => applySupportConfiguration(catalog, { candidates: [] }),
    (error) =>
      error instanceof SupportConfigurationError &&
      /routeId is duplicated: p\/a\/b/.test(error.message),
  );
  assert.throws(
    () =>
      applySupportConfiguration(catalog, {
        candidates: [
          {
            routeId: "p/a/b",
            supportState: "configured",
            operations: ["chat"],
            evidence: { observedAt: "2026-09-24T11:00:00.000Z" },
          },
        ],
      }),
    (error) =>
      error instanceof SupportConfigurationError &&
      /routeId is duplicated: p\/a\/b/.test(error.message),
  );
});
