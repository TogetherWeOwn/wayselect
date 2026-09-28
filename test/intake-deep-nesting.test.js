// Deep-nesting DoS regression pin (TOG-8429).
//
// `assertNoLocationFields` in src/sellerSubmission.js (and its twin in
// src/purchase.js) used to recurse one call frame per nesting level, so a
// single unauthenticated POST /sellers/submissions with a few-thousand-deep
// `{"n": ...}` chain in `provenance.nested` (~36KB, under the 64KB body gate)
// threw an uncaught RangeError that escaped the route's typed-error catch and
// killed the whole preview process (one request = remote DoS). Both scanners
// are now explicit-stack loops visiting the same nodes in the same pre-order,
// so any depth fails closed with a typed error and the process survives.
//
// Pinned here:
//   - unit: 6000-deep and 10000-deep chains reject with the same typed error
//     a shallow unknown field gets (`unknown-field` / `provenance.nested`),
//     and a forbidden field buried at the bottom of a 6000-deep chain still
//     reports `forbidden-field` (scan order unchanged);
//   - live HTTP: a string-built 6000-deep body (the client never recurses)
//     gets a 400 `invalid_submission` envelope, `/healthz` stays 200, and a
//     valid intake still 200s afterwards — the server survives the repro.
//
// node:test, zero dependencies, stub fixtures only.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createApp } from "../web/server.js";
import {
  PurchaseSubmissionError,
  SellerSubmissionError,
  validatePurchaseSubmission,
  validateSellerSubmission,
} from "../src/index.js";

const SELLER_SOURCE = "synthetic://wayselect/seller-fixture-v1";
const PURCHASE_SOURCE = "synthetic://wayselect/purchase-fixture-v1";
// Far-future reference clock so fixture fetchedAt values (2026-09-24) are
// never "future" inside these tests regardless of the real wall clock.
const NOW = "2026-09-27T00:00:00.000Z";
// The issue repro: 6000-deep `{"n": ...}` chain (~36KB, under the 64KB gate).
// 10000-deep (~60KB) is the deepest shape that still fits the gate.
const REPRO_DEPTH = 6000;
const GATE_FITTING_DEPTH = 10000;

// Iterative chain builder: no recursion on the test side either, so the test
// itself can never be the thing that overflows the stack.
function deepChain(depth, leaf = 0) {
  let current = leaf;
  for (let index = 0; index < depth; index += 1) {
    current = { n: current };
  }
  return current;
}

async function sellerBodyWithNested(nested) {
  const fixtures = JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
  return {
    providerId: "northstar",
    modelId: "seller-chat",
    entry: fixtures.valid.entry,
    provenance: {
      source: SELLER_SOURCE,
      fetchedAt: "2026-09-24T10:00:00.000Z",
      nested,
    },
  };
}

// String-built deep body: the HTTP client never recurses and never builds a
// deep object graph — the depth only exists in the bytes on the wire, exactly
// like the issue repro.
function deepBodyString(depth, entryJson) {
  let nested = "0";
  for (let index = 0; index < depth; index += 1) {
    nested = `{"n":${nested}}`;
  }
  return (
    `{"providerId":"northstar","modelId":"seller-chat","entry":${entryJson},` +
    `"provenance":{"source":"${SELLER_SOURCE}",` +
    `"fetchedAt":"2026-09-24T10:00:00.000Z","nested":${nested}}}`
  );
}

describe("deep-nesting DoS regression (TOG-8429)", () => {
  it("seller validator fails closed with unknown-field at 6000 and 10000 depth", async () => {
    for (const depth of [REPRO_DEPTH, GATE_FITTING_DEPTH]) {
      const body = await sellerBodyWithNested(deepChain(depth));
      try {
        validateSellerSubmission(body, { now: NOW });
      } catch (error) {
        ok(error instanceof SellerSubmissionError, `depth ${depth}: typed error, got ${error}`);
        strictEqual(error.code, "unknown-field", `depth ${depth}: code`);
        strictEqual(error.key, "provenance.nested", `depth ${depth}: key`);
        strictEqual(error.source, SELLER_SOURCE, `depth ${depth}: source`);
        continue;
      }
      throw new Error(`depth ${depth}: expected a typed rejection, but the submission passed`);
    }
  });

  it("seller validator still reports a forbidden field buried at the bottom of a deep chain", async () => {
    const body = await sellerBodyWithNested(deepChain(REPRO_DEPTH, { url: "https://evil.example.invalid" }));
    try {
      validateSellerSubmission(body, { now: NOW });
    } catch (error) {
      ok(error instanceof SellerSubmissionError, `expected SellerSubmissionError, got ${error}`);
      strictEqual(error.code, "forbidden-field", "buried url stays forbidden, not unknown");
      ok(
        String(error.key).endsWith(".url"),
        `forbidden key names the buried field, got ${error.key?.slice(-60)}`,
      );
      return;
    }
    throw new Error("expected a forbidden-field rejection for the buried url, but the submission passed");
  });

  it("purchase validator fails closed with unknown-field at repro depth", async () => {
    const fixtures = JSON.parse(
      await readFile(new URL("../fixtures/purchase.synthetic.json", import.meta.url), "utf8"),
    );
    const body = {
      ...fixtures.valid,
      provenance: { ...fixtures.valid.provenance, nested: deepChain(REPRO_DEPTH) },
    };
    try {
      validatePurchaseSubmission(body, { now: NOW });
    } catch (error) {
      ok(error instanceof PurchaseSubmissionError, `expected PurchaseSubmissionError, got ${error}`);
      strictEqual(error.code, "unknown-field", "code");
      strictEqual(error.key, "provenance.nested", "key");
      strictEqual(error.source, PURCHASE_SOURCE, "source");
      return;
    }
    throw new Error("expected a typed purchase rejection, but the submission passed");
  });

  it("live server answers 400 to the string-built repro body and survives it", async () => {
    const fixtures = JSON.parse(
      await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
    );
    const server = createApp({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const body = deepBodyString(REPRO_DEPTH, JSON.stringify(fixtures.valid.entry));
    ok(
      Buffer.byteLength(body) < 64 * 1024,
      `repro body must fit under the 64KB gate, got ${Buffer.byteLength(body)} bytes`,
    );
    const res = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    strictEqual(res.status, 400, "deep body is a 400, not a process exit");
    const payload = await res.json();
    strictEqual(payload.error, "invalid_submission", "error envelope");
    strictEqual(payload.code, "unknown-field", "typed code");
    strictEqual(payload.key, "provenance.nested", "offending key");

    // The process survived: liveness plus a valid intake on the same server.
    const health = await fetch(`${base}/healthz`);
    strictEqual(health.status, 200, "server still answers liveness after the repro");
    const valid = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(valid.status, 200, "valid intake still succeeds after the repro");
    ok(
      typeof (await valid.json()).confirmPath === "string",
      "valid intake still returns its confirmPath",
    );
  });
});
