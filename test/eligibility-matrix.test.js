import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  SCHEMA_VERSION,
  validateCatalogEntry,
} from "../src/validate-catalog-entry.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));

// Eligibility matrix: every catalog entry maps to exactly one class.
//
// - "eligible": passes fail-closed validation; may proceed to capability checks.
// - "ineligible": rejected for malformed shape, unauthorized fields, or a
//   non-object payload; never selectable.
// - "stale-catalog-fail-closed": rejected because its schemaVersion is stale or
//   missing; an outdated catalog must never read as eligible.
function classifyEligibility(entry) {
  const result = validateCatalogEntry(entry);
  if (result.ok) {
    return { eligibility: "eligible", result };
  }
  if (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    entry.schemaVersion !== SCHEMA_VERSION
  ) {
    return { eligibility: "stale-catalog-fail-closed", result };
  }
  return { eligibility: "ineligible", result };
}

const withoutSchemaVersion = (() => {
  const entry = fixture("valid.json");
  delete entry.schemaVersion;
  return entry;
})();

const MATRIX = [
  {
    name: "well-formed v1 entry",
    entry: fixture("valid.json"),
    expected: "eligible",
    errorPattern: null,
  },
  {
    name: "malformed entry",
    entry: fixture("malformed.json"),
    expected: "ineligible",
    errorPattern: /Catalog entry rejected/,
  },
  {
    name: "stale schemaVersion (v0)",
    entry: fixture("stale.json"),
    expected: "stale-catalog-fail-closed",
    errorPattern: /unsupported schemaVersion/,
  },
  {
    name: "missing schemaVersion",
    entry: withoutSchemaVersion,
    expected: "stale-catalog-fail-closed",
    errorPattern: /unsupported schemaVersion/,
  },
  {
    name: "unauthorized unknown fields",
    entry: fixture("unknown-field.json"),
    expected: "ineligible",
    errorPattern: /additionalProperties|must NOT have additional/,
  },
  {
    name: "null entry",
    entry: null,
    expected: "ineligible",
    errorPattern: /entry must be an object/,
  },
  {
    name: "array entry",
    entry: [],
    expected: "ineligible",
    errorPattern: /entry must be an object/,
  },
];

describe("eligibility matrix (eligible / ineligible / stale-catalog-fail-closed)", () => {
  it("covers the stale-catalog fail-closed case", () => {
    assert.ok(
      MATRIX.some((row) => row.expected === "stale-catalog-fail-closed"),
      "matrix must keep at least one stale-catalog-fail-closed row",
    );
  });

  for (const row of MATRIX) {
    it(`matrix row: ${row.name} -> ${row.expected}`, () => {
      const { eligibility, result } = classifyEligibility(row.entry);
      assert.equal(eligibility, row.expected);
      if (row.expected === "eligible") {
        assert.deepEqual(result, { ok: true });
      } else {
        assert.equal(result.ok, false);
        assert.match(result.error, row.errorPattern);
      }
    });
  }

  it("never classifies a rejected entry as eligible (fail-closed)", () => {
    for (const row of MATRIX.filter((entry) => entry.expected !== "eligible")) {
      const { eligibility, result } = classifyEligibility(row.entry);
      assert.notEqual(eligibility, "eligible");
      assert.equal(result.ok, false);
    }
  });

  it("every rejection carries provenance so bad entries are traceable", () => {
    for (const row of MATRIX.filter((entry) => entry.expected !== "eligible")) {
      const { result } = classifyEligibility(row.entry);
      assert.match(result.error, /source=\S+ fetchedAt=\S+/);
    }
  });
});
