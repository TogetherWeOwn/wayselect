import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { validateCatalogEntry, SCHEMA_VERSION } from "../src/validate-catalog-entry.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("catalog-entry validation (fail-closed)", () => {
  it("accepts a well-formed v1 entry", () => {
    assert.deepEqual(validateCatalogEntry(fixture("valid.json")), { ok: true });
  });

  it("rejects a malformed entry, with provenance in the error", () => {
    const result = validateCatalogEntry(fixture("malformed.json"));
    assert.equal(result.ok, false);
    assert.match(result.error, /Catalog entry rejected/);
    assert.match(
      result.error,
      /source=https:\/\/models\.dev\/api\.json fetchedAt=2026-09-26/,
    );
  });

  it("rejects a stale (non-v1) entry, with provenance in the error", () => {
    const result = validateCatalogEntry(fixture("stale.json"));
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported schemaVersion/);
    assert.match(
      result.error,
      /source=https:\/\/models\.dev\/api\.json fetchedAt=2025-01-01/,
    );
  });

  it("pins the accepted schema version to v1", () => {
    assert.equal(SCHEMA_VERSION, "v1");
  });

  it("rejects a future (v2) entry, with provenance in the error", () => {
    const entry = fixture("valid.json");
    entry.schemaVersion = "v2";
    const result = validateCatalogEntry(entry);
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported schemaVersion "v2" \(expected "v1"\)/);
    assert.match(
      result.error,
      /source=https:\/\/models\.dev\/api\.json fetchedAt=2026-09-26/,
    );
  });

  it("rejects a missing schemaVersion, with provenance in the error", () => {
    const entry = fixture("valid.json");
    delete entry.schemaVersion;
    const result = validateCatalogEntry(entry);
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported schemaVersion/);
    assert.match(
      result.error,
      /source=https:\/\/models\.dev\/api\.json fetchedAt=2026-09-26/,
    );
  });

  it("rejects an entry with unauthorized unknown fields, with provenance in the error", () => {
    const result = validateCatalogEntry(fixture("unknown-field.json"));
    assert.equal(result.ok, false);
    assert.match(result.error, /additionalProperties|must NOT have additional/);
    assert.match(
      result.error,
      /source=https:\/\/models\.dev\/api\.json fetchedAt=2026-09-26/,
    );
  });
});
