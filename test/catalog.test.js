import test from "node:test";
import assert from "node:assert/strict";
import { CatalogValidationError, normalizeCatalog } from "../src/index.js";
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
    () => normalizeCatalog(catalog, fixture.provenance),
    /unknown field: endpoint/,
  );
});

test("rejects malformed model capability data", async () => {
  const fixture = await readFixture("catalog.synthetic.json");
  const catalog = structuredClone(fixture.catalog);
  catalog.northstar.models["alpha-chat"].tool_call = "yes";

  assert.throws(
    () => normalizeCatalog(catalog, fixture.provenance),
    /tool_call must be a boolean/,
  );
});
