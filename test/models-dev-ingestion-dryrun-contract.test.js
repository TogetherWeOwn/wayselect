// Models.dev ingestion dry-run contract (TOG-5756, supports TOG-4791).
//
// Pins the interface the TOG-4791 ingestion adapter lands against: a small
// newly-authored models.dev-shaped fixture in, a normalized catalog out, and
// a dry-run selection over the result. No network, no credentials —
// `globalThis.fetch` is mocked to throw and every test asserts zero calls.
//
// What is pinned here (against src/ingest.js as merged to main via PR #49):
//   1. `ingestModelsDev` maps models.dev-shaped input onto catalog input with
//      provenance (`source`, `snapshotTimestamp`, canonical-body `snapshotHash`).
//   2. `limit: {context, output}` maps onto `context_window` /
//      `max_output_tokens`; known upstream extras (`api`, `endpoint`, `doc`,
//      pricing siblings, card metadata) are stripped, never guessed.
//   3. Unknown/malformed models quarantine with named reasons; the rest still
//      normalize cleanly as support state `catalogued` only.
//   4. An explicit `snapshotHash` that does not match the ingested body fails
//      closed (`IngestError`) instead of producing an unverifiable document.
//   5. The ingested catalog feeds the standard dry-run pipeline
//      (normalize -> configure -> select) with a deterministic pick, and a
//      stale snapshot refuses routing (`stale-catalog`, no transport).
//
// node:test, zero dependencies beyond the repo's own src/ modules.

import test from "node:test";
import assert from "node:assert/strict";
import {
  applySupportConfiguration,
  computeCatalogSnapshotHash,
  normalizeCatalog,
  selectRoute,
} from "../src/index.js";
import { IngestError, ingestModelsDev } from "../src/ingest.js";

const SOURCE = "synthetic://wayselect/contract-dryrun-v1";
const SNAPSHOT_TIMESTAMP = "2026-09-24T10:00:00.000Z";
const EVALUATION_TIME = "2026-09-24T12:00:00.000Z";
const MAX_EVIDENCE_AGE_MS = 72 * 60 * 60 * 1000;
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

// Small newly-authored models.dev-shaped input. Synthetic and minimal: it
// exercises the adapter mapping only and is not a redistributed snapshot.
function contractInput() {
  return {
    acme: {
      id: "acme",
      name: "Acme Synthetic",
      doc: "https://example.invalid/acme",
      models: {
        "chat-one": {
          id: "chat-one",
          name: "Chat One",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 1, output: 2, cache_read: 0.25 },
          limit: { context: 8000, output: 2000 },
          temperature: 1,
          knowledge: "2024-01",
          release_date: "2024-02-01",
          open_weights: false,
        },
        "vision-one": {
          id: "vision-one",
          name: "Vision One",
          attachment: true,
          reasoning: false,
          tool_call: false,
          structured_output: false,
          modalities: { input: ["image", "text"], output: ["text"] },
          cost: { input: 1, output: 1 },
          limit: { context: 4000, output: 1000 },
        },
        mystery: {
          id: "mystery",
          name: "Mystery",
          modalities: { input: ["text"], output: ["text"] },
          frobnicate: true,
        },
      },
    },
    beta: {
      id: "beta",
      name: "Beta Synthetic",
      models: {
        relay: {
          id: "relay",
          name: "Relay",
          attachment: false,
          reasoning: true,
          tool_call: true,
          structured_output: false,
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 2, output: 4 },
          api: "https://example.invalid/v1/relay",
          endpoint: "https://example.invalid/v1/relay/other",
        },
      },
    },
  };
}

function ingestContract(overrides = {}) {
  return ingestModelsDev(contractInput(), {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
    ...overrides,
  });
}

function forbidNetwork(context) {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("network access is forbidden in the ingestion dry-run contract");
  });
}

function networkUnused() {
  assert.equal(globalThis.fetch.mock.callCount(), 0);
}

test("TOG-5756: ingestion maps fixture shape in with pinned provenance", async (context) => {
  forbidNetwork(context);
  const result = ingestContract();

  assert.equal(result.provenance.source, SOURCE);
  assert.equal(result.provenance.snapshotTimestamp, SNAPSHOT_TIMESTAMP);
  assert.match(result.provenance.snapshotHash, /^sha256:[a-f0-9]{64}$/);
  // Default provenance pins the canonical body hash, so ingested output
  // always passes normalizeCatalog's snapshot-hash gate.
  assert.equal(result.provenance.snapshotHash, computeCatalogSnapshotHash(result.catalog));
  assert.deepEqual(Object.keys(result.catalog).sort(), ["acme", "beta"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.provenance));
  assert.ok(Object.isFrozen(result.quarantined));
  networkUnused();
});

test("TOG-5756: limits map, extras strip, quarantined entries carry reasons", async (context) => {
  forbidNetwork(context);
  const result = ingestContract();

  const chat = result.catalog.acme.models["chat-one"];
  assert.equal(chat.tool_call, true);
  assert.equal(chat.structured_output, true);
  assert.deepEqual(chat.modalities, { input: ["text"], output: ["text"] });
  // List prices only: sibling pricing metadata is stripped.
  assert.deepEqual(chat.cost, { input: 1, output: 2 });
  // models.dev `limit: {context, output}` maps onto the normalized catalog
  // fields `context_window` / `max_output_tokens`.
  assert.equal(chat.context_window, 8000);
  assert.equal(chat.max_output_tokens, 2000);
  assert.ok(!("limit" in chat));
  // Known models.dev extras are stripped, never guessed as capabilities.
  for (const stripped of ["temperature", "knowledge", "release_date", "open_weights"]) {
    assert.ok(!(stripped in chat), `${stripped} must be stripped`);
  }

  // URL-bearing extras are stripped so no executable location leaks through.
  assert.ok(!("api" in result.catalog.beta.models.relay));
  assert.ok(!("endpoint" in result.catalog.beta.models.relay));
  assert.ok(!JSON.stringify(result.catalog).includes("example.invalid"));

  // Unknown fields quarantine with a named reason instead of passing through.
  assert.deepEqual(Object.keys(result.catalog.acme.models).sort(), ["chat-one", "vision-one"]);
  const reasons = new Map(result.quarantined.map((entry) => [entry.routeId, entry.reason]));
  assert.match(reasons.get("acme/mystery"), /unknown field: frobnicate/);
  assert.ok(Object.isFrozen(result.quarantined[0]));
  networkUnused();
});

test("TOG-5756: explicit provenance hash must match the ingested body", async (context) => {
  forbidNetwork(context);
  const first = ingestContract();

  const repinned = ingestContract({ snapshotHash: first.provenance.snapshotHash });
  assert.equal(repinned.provenance.snapshotHash, first.provenance.snapshotHash);
  assert.deepEqual(repinned.catalog, first.catalog);

  assert.throws(
    () => ingestContract({ snapshotHash: `sha256:${"b".repeat(64)}` }),
    (error) =>
      error instanceof IngestError &&
      /does not match the ingested catalog body/.test(error.message),
  );
  assert.throws(() => ingestModelsDev(contractInput(), {}), /options\.source/);
  assert.throws(
    () => ingestModelsDev({}, { source: SOURCE }),
    (error) => error instanceof IngestError && /at least one provider/.test(error.message),
  );
  networkUnused();
});

test("TOG-5756: ingested entries normalize as catalogued-only", async (context) => {
  forbidNetwork(context);
  const ingested = ingestContract();
  const catalog = normalizeCatalog(ingested.catalog, ingested.provenance);

  assert.equal(catalog.entries.length, 3);
  assert.deepEqual(
    catalog.entries.map((entry) => entry.routeId),
    ["acme/chat-one", "acme/vision-one", "beta/relay"],
  );
  for (const entry of catalog.entries) {
    assert.equal(entry.supportState, "catalogued");
    assert.ok(!("url" in entry));
    assert.ok(!("endpoint" in entry));
  }
  const byRoute = new Map(catalog.entries.map((entry) => [entry.routeId, entry]));
  assert.deepEqual(byRoute.get("acme/chat-one").catalogOperations, ["chat"]);
  assert.equal(byRoute.get("acme/chat-one").capabilities.toolUse, true);
  assert.deepEqual(byRoute.get("acme/chat-one").limits, {
    contextWindow: 8000,
    maxOutputTokens: 2000,
  });
  // vision-one takes image+text in with text out, so it serves both chat and
  // vision-chat; relay has no limits data, which stays null (never guessed).
  assert.deepEqual(byRoute.get("acme/vision-one").catalogOperations, ["chat", "vision-chat"]);
  assert.deepEqual(byRoute.get("beta/relay").limits, {
    contextWindow: null,
    maxOutputTokens: null,
  });
  networkUnused();
});

test("TOG-5756: ingested catalog feeds the dry-run selection pipeline", async (context) => {
  forbidNetwork(context);
  const ingested = ingestContract();
  const catalog = normalizeCatalog(ingested.catalog, ingested.provenance);

  const candidates = applySupportConfiguration(catalog, {
    candidates: [
      {
        routeId: "acme/chat-one",
        supportState: "configured",
        operations: ["chat"],
        evidence: { observedAt: "2026-09-24T11:00:00.000Z" },
      },
    ],
  });

  const result = selectRoute(
    candidates,
    { operation: "chat", requiredCapabilities: ["toolUse"], providerAllowlist: ["acme"] },
    {
      now: new Date(EVALUATION_TIME),
      maxEvidenceAgeMs: MAX_EVIDENCE_AGE_MS,
      catalog,
      maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
    },
  );

  assert.equal(result.status, "selected");
  assert.equal(result.dryRun, true);
  assert.equal(result.selected.routeId, "acme/chat-one");
  assert.ok(
    result.candidates.every((candidate) =>
      candidate.routeId === "acme/chat-one" ? candidate.eligible : !candidate.eligible,
    ),
    "only the configured ingested route is eligible",
  );
  networkUnused();
});

test("TOG-5756: stale ingested snapshot refuses routing with no transport", async (context) => {
  forbidNetwork(context);
  const ingested = ingestContract();
  const catalog = normalizeCatalog(ingested.catalog, ingested.provenance);

  const candidates = applySupportConfiguration(catalog, {
    candidates: [
      {
        routeId: "acme/chat-one",
        supportState: "configured",
        operations: ["chat"],
        evidence: { observedAt: "2026-09-24T11:00:00.000Z" },
      },
    ],
  });

  // Snapshot + 24h limit + 1s => stale; the gate under test is catalog
  // staleness, not evidence (evidence age is ~23h, inside the 72h window).
  const staleNow = new Date(Date.parse(SNAPSHOT_TIMESTAMP) + MAX_CATALOG_AGE_MS + 1000);
  const result = selectRoute(
    candidates,
    { operation: "chat", requiredCapabilities: ["toolUse"], providerAllowlist: ["acme"] },
    {
      now: staleNow,
      maxEvidenceAgeMs: MAX_EVIDENCE_AGE_MS,
      catalog,
      maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
    },
  );

  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.selected, null);
  assert.ok(
    result.candidates.every((candidate) => candidate.reasons.includes("stale-catalog")),
  );
  networkUnused();
});
