import test from "node:test";
import assert from "node:assert/strict";
import {
  IngestError,
  hashRawText,
  hashSnapshot,
  ingestModelsDev,
  normalizeCatalog,
} from "../src/index.js";

const SOURCE = "https://models.dev/api.json";
const SNAPSHOT_TIMESTAMP = "2026-09-24T10:00:00.000Z";

// Small newly-authored models.dev-shaped input. Synthetic and minimal: it
// exercises the adapter mapping only and is not a redistributed snapshot.
function authoredInput() {
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
      },
    },
  };
}

function ingestAuthored(overrides = {}) {
  return ingestModelsDev(authoredInput(), {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
    ...overrides,
  });
}

test("maps models.dev-shaped input into catalog input with provenance", () => {
  const result = ingestAuthored();

  // Default provenance pins the canonical body hash, so the ingested output
  // always passes normalizeCatalog's snapshot-hash gate.
  assert.equal(result.provenance.source, SOURCE);
  assert.equal(result.provenance.snapshotTimestamp, SNAPSHOT_TIMESTAMP);
  assert.match(result.provenance.snapshotHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(Object.keys(result.catalog), ["acme"]);

  const chat = result.catalog.acme.models["chat-one"];
  assert.equal(chat.id, "chat-one");
  assert.equal(chat.name, "Chat One");
  assert.equal(chat.tool_call, true);
  assert.equal(chat.structured_output, true);
  assert.deepEqual(chat.modalities, { input: ["text"], output: ["text"] });
  assert.deepEqual(chat.cost, { input: 1, output: 2 });
  // models.dev `limit: {context, output}` maps onto the normalized catalog
  // fields `context_window` / `max_output_tokens`.
  assert.deepEqual(
    { context_window: chat.context_window, max_output_tokens: chat.max_output_tokens },
    { context_window: 8000, max_output_tokens: 2000 },
  );
  assert.ok(!("limit" in chat));
  // Known models.dev extras are stripped, never guessed as capabilities.
  assert.ok(!("temperature" in chat));
  assert.ok(!("knowledge" in chat));
  assert.ok(!("cache_read" in (chat.cost ?? {})));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.provenance));
});

test("explicit snapshot hash must match the ingested body", () => {
  const first = ingestAuthored();
  const pinned = first.provenance.snapshotHash;

  const repinned = ingestAuthored({ snapshotHash: pinned });
  assert.deepEqual(repinned.provenance.snapshotHash, pinned);
  assert.deepEqual(repinned.catalog, first.catalog);

  assert.throws(
    () => ingestAuthored({ snapshotHash: `sha256:${"b".repeat(64)}` }),
    (error) =>
      error instanceof IngestError && /does not match the ingested catalog body/.test(error.message),
  );
});

test("ingested entries normalize as catalogued-only with mapped capabilities", () => {
  const ingested = ingestAuthored();
  const catalog = normalizeCatalog(ingested.catalog, ingested.provenance);

  assert.ok(catalog.entries.length > 0);
  for (const entry of catalog.entries) {
    assert.equal(entry.supportState, "catalogued");
    assert.ok(!("url" in entry));
    assert.ok(!("endpoint" in entry));
  }
  const byRoute = new Map(catalog.entries.map((entry) => [entry.routeId, entry]));
  assert.deepEqual(byRoute.get("acme/chat-one").catalogOperations, ["chat"]);
  assert.equal(byRoute.get("acme/chat-one").capabilities.toolUse, true);
  // vision-one has image+text input with text output, so it serves both
  // `chat` and `vision-chat`.
  assert.deepEqual(byRoute.get("acme/vision-one").catalogOperations, [
    "chat",
    "vision-chat",
  ]);
  assert.deepEqual(byRoute.get("acme/vision-one").limits, {
    contextWindow: 4000,
    maxOutputTokens: 1000,
  });
  assert.deepEqual(byRoute.get("acme/chat-one").modalities, {
    input: ["text"],
    output: ["text"],
  });
});

test("a partial limit maps each present side and leaves the rest absent", () => {
  const input = authoredInput();
  input.acme.models["partial"] = {
    id: "partial",
    name: "Partial",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 16000 },
  };

  const result = ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  const partial = result.catalog.acme.models.partial;
  assert.equal(partial.context_window, 16000);
  assert.ok(!("max_output_tokens" in partial));

  const catalog = normalizeCatalog(result.catalog, result.provenance);
  const entry = catalog.entries.find((candidate) => candidate.routeId === "acme/partial");
  assert.deepEqual(entry.limits, { contextWindow: 16000, maxOutputTokens: null });
});

test("quarantines models with unknown limit subfields", () => {
  const input = authoredInput();
  input.acme.models.extra = {
    id: "extra",
    name: "Extra",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 8000, bogus: 1 },
  };

  const result = ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });

  // The unknown `limit` subfield quarantines the model instead of being
  // silently dropped; known entries (incl. limit mapping) are unaffected.
  assert.deepEqual(Object.keys(result.catalog.acme.models).sort(), [
    "chat-one",
    "vision-one",
  ]);
  const reasons = new Map(
    result.quarantined.map((entry) => [entry.routeId, entry.reason]),
  );
  assert.match(
    reasons.get("acme/extra"),
    /limit contains unknown field: bogus/,
  );
  assert.equal(
    result.catalog.acme.models["chat-one"].context_window,
    8000,
  );
});

test("computes provenance defaults and validates provenance input", () => {
  const input = authoredInput();

  const computed = ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  assert.match(computed.provenance.snapshotHash, /^sha256:[a-f0-9]{64}$/);

  const now = ingestModelsDev(input, { source: SOURCE });
  assert.ok(Number.isFinite(Date.parse(now.provenance.snapshotTimestamp)));

  assert.throws(() => ingestModelsDev(input, {}), /options\.source/);
  assert.throws(
    () => ingestModelsDev(input, { source: SOURCE, snapshotHash: "nope" }),
    /options\.snapshotHash/,
  );
  assert.throws(
    () => ingestModelsDev(input, { source: SOURCE, snapshotTimestamp: "soon" }),
    /options\.snapshotTimestamp/,
  );
  assert.throws(() => ingestModelsDev([], { source: SOURCE }), IngestError);
  assert.throws(() => ingestModelsDev({}, { source: SOURCE }), /at least one provider/);
});

test("quarantines unknown or malformed models with reasons and keeps the rest", () => {
  const input = authoredInput();
  input.acme.models.mystery = {
    id: "mystery",
    name: "Mystery",
    modalities: { input: ["text"], output: ["text"] },
    frobnicate: true,
  };
  input.acme.models.broken = {
    id: "wrong-key",
    name: "Broken",
    modalities: { input: ["text"], output: ["text"] },
  };
  input.acme.models.shapeless = {
    id: "shapeless",
    name: "Shapeless",
    modalities: { input: "text", output: ["text"] },
  };

  const result = ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });

  assert.deepEqual(Object.keys(result.catalog.acme.models).sort(), [
    "chat-one",
    "vision-one",
  ]);
  const reasons = new Map(
    result.quarantined.map((entry) => [entry.routeId, entry.reason]),
  );
  assert.match(reasons.get("acme/mystery"), /unknown field: frobnicate/);
  assert.match(reasons.get("acme/broken"), /must match its catalog key/);
  assert.match(reasons.get("acme/shapeless"), /modalities\.input must be an array/);

  // Good entries still normalize cleanly once quarantined ones are dropped.
  const catalog = normalizeCatalog(result.catalog, result.provenance);
  assert.equal(
    catalog.entries.every((entry) => entry.supportState === "catalogued"),
    true,
  );
});

test("quarantines providers with unknown fields or malformed identity", () => {
  const badField = {
    rogue: {
      id: "rogue",
      name: "Rogue",
      datacenter: "east",
      models: {},
    },
  };
  const badFieldResult = ingestModelsDev(badField, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  assert.deepEqual(badFieldResult.catalog, {});
  assert.match(
    badFieldResult.quarantined[0].reason,
    /provider rogue: unknown field: datacenter/,
  );

  const badId = {
    rogue: { id: "someone-else", name: "Rogue", models: {} },
  };
  const badIdResult = ingestModelsDev(badId, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  assert.match(
    badIdResult.quarantined[0].reason,
    /id must match its catalog key/,
  );
});

test("never emits executable location fields", () => {
  const input = authoredInput();
  // Known models.dev location extras are stripped at the boundary.
  input.acme.api = "https://example.invalid/v1";
  input.acme.models["chat-one"].api = "https://example.invalid/v1/chat";
  input.acme.models["chat-one"].endpoint = "https://example.invalid/v1/other";

  const result = ingestModelsDev(input, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  const serialized = JSON.stringify(result.catalog);
  assert.ok(!serialized.includes("example.invalid"));

  // Genuinely unknown executable-shaped keys quarantine instead of passing through.
  const sneaky = authoredInput();
  sneaky.acme.models["chat-one"].callbackUrl = "https://example.invalid/hook";
  const sneakyResult = ingestModelsDev(sneaky, {
    source: SOURCE,
    snapshotTimestamp: SNAPSHOT_TIMESTAMP,
  });
  assert.match(
    sneakyResult.quarantined.find((entry) => entry.routeId === "acme/chat-one").reason,
    /unknown field: callbackUrl/,
  );
});

test("snapshot hashes are stable and raw-text hashes are deterministic", () => {
  const first = { b: 2, a: [3, 2, 1] };
  const reordered = { a: [3, 2, 1], b: 2 };

  assert.equal(hashSnapshot(first), hashSnapshot(reordered));
  assert.match(hashSnapshot(first), /^sha256:[a-f0-9]{64}$/);

  assert.equal(hashRawText("hello"), hashRawText("hello"));
  assert.notEqual(hashRawText("hello"), hashRawText("goodbye"));
  assert.match(hashRawText("hello"), /^sha256:[a-f0-9]{64}$/);
});
