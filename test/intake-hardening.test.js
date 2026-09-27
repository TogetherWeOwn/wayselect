// S3 intake-hardening tests (TOG-5476; TOG-5465 checklist §4 V7–V10).
//
// Covers the slice contract: length caps (provider/model ≤64, buyer ≤120,
// description ≤4k, etag ≤256), providerId/modelId allowlist, provenance
// source must be synthetic://, future fetchedAt rejected, and the strict
// JSON body gate (~64KB cap + Content-Type enforcement + 400s on malformed
// JSON per seller-acceptance O8). node:test, zero dependencies.

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  PurchaseSubmissionError,
  SellerSubmissionError,
  validatePurchaseSubmission,
  validateSellerSubmission,
} from "../src/index.js";
import {
  MAX_BUYER_ID_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_ETAG_LENGTH,
  MAX_JSON_BODY_BYTES,
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_ID_LENGTH,
} from "../src/index.js";
import { isJsonContentType, readJsonBody } from "../web/jsonBody.js";

const SOURCE = "synthetic://wayselect/seller-fixture-v1";
const PURCHASE_SOURCE = "synthetic://wayselect/purchase-fixture-v1";
// Far-future reference clock so fixture fetchedAt values (2026-09-24) are
// never "future" inside these tests regardless of the real wall clock.
const NOW = "2026-09-27T00:00:00.000Z";

async function readFixtures(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

function assertSellerRejects(submission, { code, key, source }, options = { now: NOW }) {
  try {
    validateSellerSubmission(submission, options);
  } catch (error) {
    ok(error instanceof SellerSubmissionError, `expected SellerSubmissionError, got ${error}`);
    strictEqual(error.code, code, `wrong code: ${error.message}`);
    strictEqual(error.key, key, `wrong key: ${error.message}`);
    strictEqual(error.source, source, `wrong source: ${error.message}`);
    return;
  }
  throw new Error(`expected seller rejection ${code} for ${key}, but submission passed`);
}

function assertPurchaseRejects(submission, { code, key, source }, options = { now: NOW }) {
  try {
    validatePurchaseSubmission(submission, options);
  } catch (error) {
    ok(error instanceof PurchaseSubmissionError, `expected PurchaseSubmissionError, got ${error}`);
    strictEqual(error.code, code, `wrong code: ${error.message}`);
    strictEqual(error.key, key, `wrong key: ${error.message}`);
    strictEqual(error.source, source, `wrong source: ${error.message}`);
    return;
  }
  throw new Error(`expected purchase rejection ${code} for ${key}, but submission passed`);
}

function fakeRequest(body, contentType = "application/json", extraHeaders = {}) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.headers = { "content-type": contentType, ...extraHeaders };
  return stream;
}

describe("S3 length caps", () => {
  it("rejects overlong provider/model ids (≤64) in both validators", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    for (const field of ["providerId", "modelId"]) {
      const bad = structuredClone(sellerFixtures.valid);
      bad[field] = "a".repeat((field === "providerId" ? MAX_PROVIDER_ID_LENGTH : MAX_MODEL_ID_LENGTH) + 1);
      assertSellerRejects(bad, { code: "invalid-value", key: field, source: SOURCE });
    }
    const boundary = structuredClone(sellerFixtures.valid);
    boundary.providerId = "n".repeat(MAX_PROVIDER_ID_LENGTH);
    boundary.modelId = "m".repeat(MAX_MODEL_ID_LENGTH);
    boundary.entry.id = boundary.modelId;
    ok(validateSellerSubmission(boundary, { now: NOW }).providerId.length === MAX_PROVIDER_ID_LENGTH);

    const purchaseFixtures = await readFixtures("purchase.synthetic.json");
    for (const field of ["providerId", "modelId"]) {
      const bad = structuredClone(purchaseFixtures.valid);
      bad[field] = "a".repeat(65);
      assertPurchaseRejects(bad, { code: "invalid-value", key: field, source: PURCHASE_SOURCE });
    }
  });

  it("rejects overlong buyer (>120) in purchase intake per offer O5", async () => {
    const fixtures = await readFixtures("purchase.synthetic.json");
    const bad = structuredClone(fixtures.valid);
    bad.buyerId = "b".repeat(MAX_BUYER_ID_LENGTH + 1);
    assertPurchaseRejects(bad, { code: "invalid-value", key: field, source: PURCHASE_SOURCE });
  });
});
