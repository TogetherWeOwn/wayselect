// Fail-closed seller-submission intake validation tests (TOG-5118).
//
// Test leaf for the TOG-4969 build slice against typed fixtures, no backend
// (node:test, zero dependencies). Every malformed submission must be rejected
// with a typed SellerSubmissionError carrying a stable `code`, the offending
// `key`, and the provenance `source` (spec SD8).

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { SellerSubmissionError, validateSellerSubmission } from "../src/index.js";

async function readSellerFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
}

function validSubmission(fixtures) {
  return structuredClone(fixtures.valid);
}

function assertRejects(submission, { code, key, source }) {
  try {
    validateSellerSubmission(submission);
  } catch (error) {
    ok(error instanceof SellerSubmissionError, `expected SellerSubmissionError, got ${error}`);
    strictEqual(error.name, "SellerSubmissionError");
    strictEqual(error.code, code, `wrong code: ${error.message}`);
    strictEqual(error.key, key, `wrong key: ${error.message}`);
    strictEqual(error.source, source, `wrong source: ${error.message}`);
    ok(
      error.message.includes(source ?? "provenance missing"),
      `rejection must name the provenance source: ${error.message}`,
    );
    return;
  }
  throw new Error(`expected rejection with code ${code} for key ${key}, but submission passed`);
}

describe("seller-submission intake", () => {
  it("accepts a valid submission with normalized frozen output", async () => {
    const fixtures = await readSellerFixtures();
    const result = validateSellerSubmission(validSubmission(fixtures));

    strictEqual(result.routeId, "northstar/seller-chat");
    strictEqual(result.providerId, "northstar");
    strictEqual(result.modelId, "seller-chat");
    strictEqual(result.entry.name, "Seller Chat");
    deepStrictEqual(result.entry.modalities, { input: ["text"], output: ["text"] });
    deepStrictEqual(result.entry.cost, { input: 1, output: 2 });
    strictEqual(result.entry.status, "beta");
    strictEqual(result.provenance.source, "synthetic://wayselect/seller-fixture-v1");
    strictEqual(result.provenance.fetchedAt, "2026-09-24T10:00:00.000Z");
    ok(Object.isFrozen(result));
    ok(Object.isFrozen(result.entry));
    ok(Object.isFrozen(result.provenance));
  });

  it("accepts a minimal submission: unpublished price, absent status, optional flags unknown", async () => {
    const fixtures = await readSellerFixtures();
    const result = validateSellerSubmission(structuredClone(fixtures.minimal));

    strictEqual(result.routeId, "northstar/price-unpublished");
    strictEqual(result.entry.cost, null);
    strictEqual(result.entry.status, null);
    strictEqual(result.entry.structured_output, null);
    strictEqual(result.entry.temperature, null);
    strictEqual(result.provenance.etag, "synthetic-etag-1");
  });

  it("rejects non-object submissions fail-closed", async () => {
    for (const bad of [null, "nope", 42, ["array"]]) {
      assertRejects(bad, { code: "invalid-type", key: "submission", source: null });
    }
  });

  it("rejects a missing submission envelope and missing entry", async () => {
    const fixtures = await readSellerFixtures();
    const noProvenance = validSubmission(fixtures);
    delete noProvenance.provenance;
    assertRejects(noProvenance, {
      code: "missing-provenance",
      key: "provenance",
      source: null,
    });

    const noEntry = validSubmission(fixtures);
    delete noEntry.entry;
    assertRejects(noEntry, {
      code: "missing-field",
      key: "entry",
      source: "synthetic://wayselect/seller-fixture-v1",
    });
  });

  it("rejects unknown fields at every object level", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    const topLevel = validSubmission(fixtures);
    topLevel.family = "seller-family";
    assertRejects(topLevel, {
      code: "unknown-field",
      key: "submission.family",
      source,
    });

    const entryLevel = validSubmission(fixtures);
    entryLevel.entry.family = "seller-family";
    assertRejects(entryLevel, {
      code: "unknown-field",
      key: "entry.family",
      source,
    });

    const modalitiesLevel = validSubmission(fixtures);
    modalitiesLevel.entry.modalities.audio = ["text"];
    assertRejects(modalitiesLevel, {
      code: "unknown-field",
      key: "entry.modalities.audio",
      source,
    });

    const limitLevel = validSubmission(fixtures);
    limitLevel.entry.limit.tokens = 1;
    assertRejects(limitLevel, {
      code: "unknown-field",
      key: "entry.limit.tokens",
      source,
    });

    const costLevel = validSubmission(fixtures);
    costLevel.entry.cost.total = 9;
    assertRejects(costLevel, {
      code: "unknown-field",
      key: "entry.cost.total",
      source,
    });

    const provenanceLevel = validSubmission(fixtures);
    provenanceLevel.provenance.hash = "sha256:x";
    assertRejects(provenanceLevel, {
      code: "unknown-field",
      key: "provenance.hash",
      source,
    });
  });

  it("never accepts executable location fields at any depth", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    for (const field of ["url", "endpoint", "baseUrl", "apiUrl"]) {
      const topLevel = validSubmission(fixtures);
      topLevel[field] = "https://example.invalid/x";
      assertRejects(topLevel, {
        code: "forbidden-field",
        key: `submission.${field}`,
        source,
      });

      const nested = validSubmission(fixtures);
      nested.entry[field] = "https://example.invalid/x";
      assertRejects(nested, {
        code: "forbidden-field",
        key: `submission.entry.${field}`,
        source,
      });

      const deep = validSubmission(fixtures);
      deep.entry.modalities[field] = ["text"];
      assertRejects(deep, {
        code: "forbidden-field",
        key: `submission.entry.modalities.${field}`,
        source,
      });

      const inProvenance = validSubmission(fixtures);
      inProvenance.provenance[field] = "https://example.invalid/x";
      assertRejects(inProvenance, {
        code: "forbidden-field",
        key: `provenance.${field}`,
        source,
      });
    }
  });

  it("requires seller identity and rejects modelId/entry.id mismatch", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    for (const providerId of [undefined, "", "   "]) {
      const bad = validSubmission(fixtures);
      bad.providerId = providerId;
      assertRejects(bad, { code: "missing-field", key: "providerId", source });
    }

    const mismatched = validSubmission(fixtures);
    mismatched.modelId = "other-id";
    assertRejects(mismatched, { code: "id-mismatch", key: "modelId", source });
  });

  it("requires every §2 required entry field", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";
    const required = [
      "id",
      "name",
      "description",
      "attachment",
      "reasoning",
      "tool_call",
      "modalities",
      "limit",
      "release_date",
      "last_updated",
      "open_weights",
    ];
    for (const field of required) {
      const bad = validSubmission(fixtures);
      delete bad.entry[field];
      assertRejects(bad, { code: "missing-field", key: `entry.${field}`, source });
    }
  });

  it("rejects mistyped capability flags and temperature", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";
    for (const field of ["attachment", "reasoning", "tool_call", "structured_output", "temperature"]) {
      const bad = validSubmission(fixtures);
      bad.entry[field] = "yes";
      assertRejects(bad, { code: "invalid-type", key: `entry.${field}`, source });
    }
  });

  it("rejects malformed modalities", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    const empty = validSubmission(fixtures);
    empty.entry.modalities.input = [];
    assertRejects(empty, {
      code: "missing-field",
      key: "entry.modalities.input",
      source,
    });

    const unknownValue = validSubmission(fixtures);
    unknownValue.entry.modalities.output = ["telepathy"];
    assertRejects(unknownValue, {
      code: "invalid-value",
      key: "entry.modalities.output",
      source,
    });

    const missingOutput = validSubmission(fixtures);
    delete missingOutput.entry.modalities.output;
    assertRejects(missingOutput, {
      code: "missing-field",
      key: "entry.modalities",
      source,
    });
  });

  it("rejects malformed limits", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    const negative = validSubmission(fixtures);
    negative.entry.limit.context = -1;
    assertRejects(negative, {
      code: "invalid-value",
      key: "entry.limit.context",
      source,
    });

    const fractional = validSubmission(fixtures);
    fractional.entry.limit.output = 1.5;
    assertRejects(fractional, {
      code: "invalid-value",
      key: "entry.limit.output",
      source,
    });

    const missingContext = validSubmission(fixtures);
    delete missingContext.entry.limit.context;
    assertRejects(missingContext, {
      code: "missing-field",
      key: "entry.limit",
      source,
    });
  });

  it("rejects malformed as-published cost", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    const negative = validSubmission(fixtures);
    negative.entry.cost.input = -0.5;
    assertRejects(negative, {
      code: "invalid-value",
      key: "entry.cost.input",
      source,
    });

    const partial = validSubmission(fixtures);
    delete partial.entry.cost.output;
    assertRejects(partial, {
      code: "missing-field",
      key: "entry.cost",
      source,
    });
  });

  it("rejects malformed release dates and status", async () => {
    const fixtures = await readSellerFixtures();
    const source = "synthetic://wayselect/seller-fixture-v1";

    const badFormat = validSubmission(fixtures);
    badFormat.entry.release_date = "09/2026";
    assertRejects(badFormat, {
      code: "invalid-value",
      key: "entry.release_date",
      source,
    });

    const impossible = validSubmission(fixtures);
    impossible.entry.last_updated = "2026-02-30";
    assertRejects(impossible, {
      code: "invalid-value",
      key: "entry.last_updated",
      source,
    });

    const badStatus = validSubmission(fixtures);
    badStatus.entry.status = "live";
    assertRejects(badStatus, {
      code: "invalid-value",
      key: "entry.status",
      source,
    });

    const deprecated = validSubmission(fixtures);
    deprecated.entry.status = "deprecated";
    strictEqual(validateSellerSubmission(deprecated).entry.status, "deprecated");
  });

  it("rejects malformed provenance fail-closed", async () => {
    const fixtures = await readSellerFixtures();

    const noSource = validSubmission(fixtures);
    delete noSource.provenance.source;
    assertRejects(noSource, {
      code: "missing-field",
      key: "provenance.source",
      source: null,
    });

    const noFetchedAt = validSubmission(fixtures);
    delete noFetchedAt.provenance.fetchedAt;
    assertRejects(noFetchedAt, {
      code: "missing-field",
      key: "provenance.fetchedAt",
      source: "synthetic://wayselect/seller-fixture-v1",
    });

    const badFetchedAt = validSubmission(fixtures);
    badFetchedAt.entry.release_date = "2026-09";
    badFetchedAt.provenance.fetchedAt = "not-a-timestamp";
    assertRejects(badFetchedAt, {
      code: "invalid-value",
      key: "provenance.fetchedAt",
      source: "synthetic://wayselect/seller-fixture-v1",
    });

    const nonObject = validSubmission(fixtures);
    nonObject.provenance = "synthetic://wayselect/seller-fixture-v1";
    assertRejects(nonObject, {
      code: "invalid-type",
      key: "provenance",
      source: null,
    });
  });
});
