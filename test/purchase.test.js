// Fail-closed purchase-intake validation tests (TOG-5154).
//
// Test leaf for the buyer-onboarding build slice (buyer spec: TOG-4869
// click-path listing -> eligibility check -> confirm -> receipt), landing
// independently against typed fixtures, no backend (node:test, zero
// dependencies). Sibling to test/seller-submission.test.js (TOG-5118).
// Every malformed purchase submission must be rejected with a typed
// PurchaseSubmissionError carrying a stable `code`, the offending `key`,
// and the provenance `source`.

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { PurchaseSubmissionError, validatePurchaseSubmission } from "../src/index.js";

async function readPurchaseFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/purchase.synthetic.json", import.meta.url), "utf8"),
  );
}

function validSubmission(fixtures) {
  return structuredClone(fixtures.valid);
}

function assertRejects(submission, { code, key, source }) {
  try {
    validatePurchaseSubmission(submission);
  } catch (error) {
    ok(error instanceof PurchaseSubmissionError, `expected PurchaseSubmissionError, got ${error}`);
    strictEqual(error.name, "PurchaseSubmissionError");
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

describe("purchase-submission intake", () => {
  it("accepts a valid purchase with normalized frozen output", async () => {
    const fixtures = await readPurchaseFixtures();
    const result = validatePurchaseSubmission(validSubmission(fixtures));

    strictEqual(result.routeId, "northstar/alpha-chat");
    strictEqual(result.providerId, "northstar");
    strictEqual(result.modelId, "alpha-chat");
    strictEqual(result.buyerId, "buyer-001");
    strictEqual(result.provenance.source, "synthetic://wayselect/purchase-fixture-v1");
    strictEqual(result.provenance.fetchedAt, "2026-09-24T10:00:00.000Z");
    strictEqual(result.provenance.etag, null);
    ok(Object.isFrozen(result));
    ok(Object.isFrozen(result.provenance));
  });

  it("accepts a minimal purchase with etag provenance", async () => {
    const fixtures = await readPurchaseFixtures();
    const result = validatePurchaseSubmission(structuredClone(fixtures.minimal));

    strictEqual(result.routeId, "northstar/image-lite");
    strictEqual(result.buyerId, "buyer-002");
    strictEqual(result.provenance.etag, "synthetic-etag-1");
  });

  it("rejects non-object submissions fail-closed", async () => {
    for (const bad of [null, "nope", 42, ["array"]]) {
      assertRejects(bad, { code: "invalid-type", key: "submission", source: null });
    }
  });

  it("rejects a missing provenance envelope and missing route fields", async () => {
    const fixtures = await readPurchaseFixtures();
    const source = "synthetic://wayselect/purchase-fixture-v1";

    const noProvenance = validSubmission(fixtures);
    delete noProvenance.provenance;
    assertRejects(noProvenance, {
      code: "missing-provenance",
      key: "provenance",
      source: null,
    });

    for (const field of ["providerId", "modelId", "buyerId"]) {
      const missing = validSubmission(fixtures);
      delete missing[field];
      assertRejects(missing, { code: "missing-field", key: field, source });
    }
  });

  it("rejects blank identities fail-closed", async () => {
    const fixtures = await readPurchaseFixtures();
    const source = "synthetic://wayselect/purchase-fixture-v1";

    for (const field of ["providerId", "modelId", "buyerId"]) {
      for (const bad of ["", "   "]) {
        const submission = validSubmission(fixtures);
        submission[field] = bad;
        assertRejects(submission, { code: "missing-field", key: field, source });
      }
    }
  });

  it("requires explicit confirmation: missing, mistyped, or false never proceeds", async () => {
    const fixtures = await readPurchaseFixtures();
    const source = "synthetic://wayselect/purchase-fixture-v1";

    const missing = validSubmission(fixtures);
    delete missing.confirm;
    assertRejects(missing, { code: "missing-field", key: "confirm", source });

    for (const bad of ["yes", 1, 0, null]) {
      const mistyped = validSubmission(fixtures);
      mistyped.confirm = bad;
      assertRejects(mistyped, { code: "invalid-type", key: "confirm", source });
    }

    const unconfirmed = validSubmission(fixtures);
    unconfirmed.confirm = false;
    assertRejects(unconfirmed, { code: "unconfirmed", key: "confirm", source });
  });

  it("rejects unknown fields at every object level", async () => {
    const fixtures = await readPurchaseFixtures();
    const source = "synthetic://wayselect/purchase-fixture-v1";

    const topLevel = validSubmission(fixtures);
    topLevel.quantity = 2;
    assertRejects(topLevel, {
      code: "unknown-field",
      key: "submission.quantity",
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
    const fixtures = await readPurchaseFixtures();
    const source = "synthetic://wayselect/purchase-fixture-v1";

    for (const field of ["url", "endpoint", "baseUrl", "apiUrl"]) {
      const topLevel = validSubmission(fixtures);
      topLevel[field] = "https://example.invalid/x";
      assertRejects(topLevel, {
        code: "forbidden-field",
        key: `submission.${field}`,
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

  it("rejects malformed provenance fail-closed", async () => {
    const fixtures = await readPurchaseFixtures();

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
      source: "synthetic://wayselect/purchase-fixture-v1",
    });

    const badFetchedAt = validSubmission(fixtures);
    badFetchedAt.provenance.fetchedAt = "not-a-timestamp";
    assertRejects(badFetchedAt, {
      code: "invalid-value",
      key: "provenance.fetchedAt",
      source: "synthetic://wayselect/purchase-fixture-v1",
    });

    const nonObject = validSubmission(fixtures);
    nonObject.provenance = "synthetic://wayselect/purchase-fixture-v1";
    assertRejects(nonObject, {
      code: "invalid-type",
      key: "provenance",
      source: null,
    });
  });
});
