import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogIntegrityError,
  CatalogValidationError,
  computeCatalogSnapshotHash,
  normalizeCatalog,
  verifyCatalogSnapshotHash,
} from "../src/index.js";
import { readFixture } from "../support/helpers.js";

test("normalizes a provider-keyed catalog with immutable provenance", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const result = normalizeCatalog(fixture.catalog, fixture.provenance);

  assert.equal(result.entries.length, 6);
  assert.equal(result.entries[0].routeId, "legacy/old-chat");
  assert.equal(result.entries[1].routeId, "northstar/alpha-chat");
  assert.deepEqual(result.entries[1].catalogOperations, ["chat"]);
  assert.equal(result.entries[1].supportState, "catalogued");
  assert.equal(result.entries[1].rates.label, "synthetic/list-price estimate only");
  assert.equal(result.provenance.source, "synthetic://wayselect/fixture-v1");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.provenance));
});

test("rejects malformed provenance", async () => {
  const fixture = await readFixture("catalog.synthetic.json");

  assert.throws(
    () => normalizeCatalog(fixture.catalog, { ...fixture.provenance, snapshotHash: "not-a-hash" }),
    CatalogValidationError,
  );
});

test("rejects unknown catalog fields instead of turning them into executable locations", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = structuredClone(fixture.catalog);
  catalog.northstar.models["alpha-chat"].endpoint = "https://example.invalid/models";

  assert.throws(
    () =>
      normalizeCatalog(catalog, {
        ...fixture.provenance,
        snapshotHash: computeCatalogSnapshotHash(catalog),
      }),
    /unknown field: endpoint/,
  );
});

test("rejects malformed model capability data", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = structuredClone(fixture.catalog);
  catalog.northstar.models["alpha-chat"].tool_call = "yes";

  assert.throws(
    () =>
      normalizeCatalog(catalog, {
        ...fixture.provenance,
        snapshotHash: computeCatalogSnapshotHash(catalog),
      }),
    /tool_call must be a boolean/,
  );
});

test("tampered catalog body fails closed with CatalogIntegrityError", () => {
  const fixtureBody = {
    catalog: {
      northstar: {
        id: "northstar",
        name: "Northstar Synthetic Provider",
        models: {
          "alpha-chat": {
            id: "alpha-chat",
            name: "Alpha Chat",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      snapshotTimestamp: "2026-09-24T10:00:00.000Z",
      snapshotHash:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  };

  assert.throws(
    () => normalizeCatalog(fixtureBody.catalog, fixtureBody.provenance),
    (error) =>
      error instanceof CatalogIntegrityError &&
      /does not match provenance.snapshotHash/.test(error.message),
  );
});

test("mutated fixture body without re-pinned hash is denied, not normalized", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = structuredClone(fixture.catalog);
  catalog.northstar.models["alpha-chat"].tool_call = false;

  assert.throws(
    () => normalizeCatalog(catalog, fixture.provenance),
    CatalogIntegrityError,
  );

  const repinned = normalizeCatalog(catalog, {
    ...fixture.provenance,
    snapshotHash: computeCatalogSnapshotHash(catalog),
  });
  assert.equal(
    repinned.entries.find((entry) => entry.routeId === "northstar/alpha-chat")
      .capabilities.toolUse,
    false,
  );
});

test("provenance records source, hash, and fetched-at per ingest", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const result = normalizeCatalog(fixture.catalog, fixture.provenance);

  assert.equal(result.provenance.source, fixture.provenance.source);
  assert.equal(result.provenance.snapshotHash, fixture.provenance.snapshotHash);
  assert.equal(
    result.provenance.snapshotTimestamp,
    new Date(fixture.provenance.snapshotTimestamp).toISOString(),
  );
  assert.ok(Number.isFinite(Date.parse(result.provenance.fetchedAt)));
  assert.equal(
    verifyCatalogSnapshotHash(fixture.catalog, fixture.provenance),
    fixture.provenance.snapshotHash,
  );
});
