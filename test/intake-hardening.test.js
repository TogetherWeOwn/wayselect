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
    assertPurchaseRejects(bad, { code: "invalid-value", key: "buyerId", source: PURCHASE_SOURCE });

    const boundary = structuredClone(fixtures.valid);
    boundary.buyerId = "b".repeat(MAX_BUYER_ID_LENGTH);
    strictEqual(
      validatePurchaseSubmission(boundary, { now: NOW }).buyerId.length,
      MAX_BUYER_ID_LENGTH,
    );
  });

  it("rejects overlong description (>4k) in seller intake", async () => {
    const fixtures = await readFixtures("seller-submission.synthetic.json");
    const bad = structuredClone(fixtures.valid);
    bad.entry.description = "d".repeat(MAX_DESCRIPTION_LENGTH + 1);
    assertSellerRejects(bad, { code: "invalid-value", key: "entry.description", source: SOURCE });
  });

  it("rejects overlong etag (>256) in both validators", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    const sellerBad = structuredClone(sellerFixtures.minimal);
    sellerBad.provenance.etag = "e".repeat(MAX_ETAG_LENGTH + 1);
    assertSellerRejects(sellerBad, { code: "invalid-value", key: "provenance.etag", source: SOURCE });

    const purchaseFixtures = await readFixtures("purchase.synthetic.json");
    const purchaseBad = structuredClone(purchaseFixtures.minimal);
    purchaseBad.provenance.etag = "e".repeat(MAX_ETAG_LENGTH + 1);
    assertPurchaseRejects(purchaseBad, {
      code: "invalid-value",
      key: "provenance.etag",
      source: PURCHASE_SOURCE,
    });
  });
});

describe("S3 route-id allowlist", () => {
  it("rejects slashes, traversal, uppercase, spaces and controls in provider/model ids", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    const evil = ["a/b", "../x", "Northstar", "has space", "tab\there", "", "a".repeat(65)];
    for (const value of evil) {
      for (const field of ["providerId", "modelId"]) {
        const bad = structuredClone(sellerFixtures.valid);
        bad[field] = value;
        const expectedCode = value === "" ? "missing-field" : "invalid-value";
        assertSellerRejects(bad, { code: expectedCode, key: field, source: SOURCE });
      }
    }
  });

  it("rejects non-slug entry.id in seller intake", async () => {
    const fixtures = await readFixtures("seller-submission.synthetic.json");
    const bad = structuredClone(fixtures.valid);
    bad.modelId = "evil-id";
    bad.entry.id = "evil id";
    assertSellerRejects(bad, { code: "invalid-value", key: "entry.id", source: SOURCE });
  });

  it("rejects non-slug provider/model ids in purchase intake", async () => {
    const fixtures = await readFixtures("purchase.synthetic.json");
    for (const field of ["providerId", "modelId"]) {
      const bad = structuredClone(fixtures.valid);
      bad[field] = "../../etc";
      assertPurchaseRejects(bad, { code: "invalid-value", key: field, source: PURCHASE_SOURCE });
    }
  });
});

describe("S3 synthetic provenance boundary", () => {
  it("rejects non-synthetic provenance.source in both validators", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    for (const source of ["https://models.dev/api", "file:///tmp/x", "http://example.invalid"]) {
      const bad = structuredClone(sellerFixtures.valid);
      bad.provenance.source = source;
      assertSellerRejects(bad, { code: "invalid-value", key: "provenance.source", source: null });
    }

    const purchaseFixtures = await readFixtures("purchase.synthetic.json");
    const purchaseBad = structuredClone(purchaseFixtures.valid);
    purchaseBad.provenance.source = "https://models.dev/api";
    assertPurchaseRejects(purchaseBad, {
      code: "invalid-value",
      key: "provenance.source",
      source: null,
    });
  });

  it("rejects future fetchedAt fail-closed in both validators", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    const sellerBad = structuredClone(sellerFixtures.valid);
    sellerBad.provenance.fetchedAt = "2026-09-28T00:00:00.000Z";
    assertSellerRejects(sellerBad, {
      code: "invalid-value",
      key: "provenance.fetchedAt",
      source: SOURCE,
    });

    const purchaseFixtures = await readFixtures("purchase.synthetic.json");
    const purchaseBad = structuredClone(purchaseFixtures.valid);
    purchaseBad.provenance.fetchedAt = "2026-09-28T00:00:00.000Z";
    assertPurchaseRejects(purchaseBad, {
      code: "invalid-value",
      key: "provenance.fetchedAt",
      source: PURCHASE_SOURCE,
    });
  });
});

describe("S3 strict JSON body gate (O8)", () => {
  it("parses valid JSON and accepts charset-suffixed content types", async () => {
    const result = await readJsonBody(fakeRequest('{"buyer":"mia","price":12}', "application/json; charset=utf-8"));
    strictEqual(result.ok, true);
    strictEqual(result.value.buyer, "mia");
    ok(isJsonContentType("Application/JSON"));
  });

  it("rejects wrong content types without reading the body as JSON", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
      const result = await readJsonBody(fakeRequest("buyer=mia&price=5", contentType));
      strictEqual(result.ok, false, contentType);
      strictEqual(result.code, "wrong_content_type");
    }
    // Missing header entirely (no default-parameter masking): build the
    // stream headers without content-type.
    const bare = Readable.from([Buffer.from("buyer=mia&price=5")]);
    bare.headers = {};
    const missing = await readJsonBody(bare);
    strictEqual(missing.ok, false);
    strictEqual(missing.code, "wrong_content_type");
  });

  it("rejects malformed JSON fail-closed", async () => {
    const result = await readJsonBody(fakeRequest("{not-json"));
    strictEqual(result.ok, false);
    strictEqual(result.code, "malformed_json");
  });

  it("enforces the ~64KB body cap on declared length and streamed bytes", async () => {
    strictEqual(MAX_JSON_BODY_BYTES, 64 * 1024);
    const tooBig = await readJsonBody(
      fakeRequest('{"buyer":"mia"}', "application/json", {
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      }),
    );
    strictEqual(tooBig.ok, false);
    strictEqual(tooBig.code, "body_too_large");

    const streamed = await readJsonBody(fakeRequest(`{"pad":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`));
    strictEqual(streamed.ok, false);
    strictEqual(streamed.code, "body_too_large");
  });
});
