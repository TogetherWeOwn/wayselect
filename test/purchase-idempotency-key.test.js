// Purchase idempotency-key support (TOG-6030, gap G2 from TOG-6013).
//
// The purchase stub refused with no dedup: a retried POST could double-submit
// once a real backend exists. Contract pinned here, fixture-only, no backend:
//   - validator: `validatePurchaseSubmission` accepts an optional opaque
//     `idempotencyKey` (UUID recommended, ≤ MAX_IDEMPOTENCY_KEY_LENGTH),
//     normalizes it to null when absent, and rejects blank/non-string/
//     overlong values fail-closed with typed PurchaseSubmissionError
//     (`missing-field` / `invalid-value` on `idempotencyKey`);
//   - route: POST /listings/:provider/:model/purchase honors the optional
//     `Idempotency-Key` header — same key + same (routeId, key) effect
//     replays the 403 refusal with the key echoed and `replayed: true`
//     (one recorded effect, not two); same key + different route is 422
//     `idempotency_key_reused`; blank/overlong keys are 400
//     `invalid_idempotency_key` (missing-field/invalid-value, same vocab
//     as the validator); no key refuses exactly as before with no
//     echo field; key validation never masks the 404/405 gates and every
//     error carries the TOG-6717 triage id with header/body agreement.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  PurchaseSubmissionError,
  validatePurchaseSubmission,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "../src/index.js";
import {
  createApp,
  REQUEST_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  MAX_IDEMPOTENCY_RECORDS,
} from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const SOURCE = "synthetic://wayselect/purchase-fixture-v1";
// Far-future reference clock so fixture fetchedAt values (2026-09-24) are
// never "future" inside these tests regardless of the real wall clock.
const NOW = "2026-09-27T00:00:00.000Z";

async function readPurchaseFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/purchase.synthetic.json", import.meta.url), "utf8"),
  );
}

describe("purchase idempotency-key support (TOG-6030)", () => {
  it("pins the key cap and header-name constants", () => {
    strictEqual(MAX_IDEMPOTENCY_KEY_LENGTH, 256);
    strictEqual(IDEMPOTENCY_KEY_HEADER, "idempotency-key");
    strictEqual(MAX_IDEMPOTENCY_RECORDS, 1000);
  });

  it("validator normalizes absent key to null and echoes a present key verbatim", async () => {
    const fixtures = await readPurchaseFixtures();
    const absent = validatePurchaseSubmission(structuredClone(fixtures.valid), { now: NOW });
    strictEqual(absent.idempotencyKey, null);
    strictEqual(absent.routeId, "northstar/alpha-chat");

    const keyed = structuredClone(fixtures.valid);
    keyed.idempotencyKey = "550e8400-e29b-41d4-a716-446655440000";
    const result = validatePurchaseSubmission(keyed, { now: NOW });
    strictEqual(result.idempotencyKey, "550e8400-e29b-41d4-a716-446655440000");
    ok(Object.isFrozen(result));
  });

  it("validator rejects blank, non-string, and overlong keys fail-closed", async () => {
    const fixtures = await readPurchaseFixtures();
    for (const bad of ["", "   "]) {
      const submission = structuredClone(fixtures.valid);
      submission.idempotencyKey = bad;
      try {
        validatePurchaseSubmission(submission, { now: NOW });
      } catch (error) {
        ok(error instanceof PurchaseSubmissionError);
        strictEqual(error.code, "missing-field");
        strictEqual(error.key, "idempotencyKey");
        strictEqual(error.source, SOURCE);
        continue;
      }
      throw new Error(`blank key ${JSON.stringify(bad)} passed validation`);
    }
    for (const bad of [42, true, null, ["k"], { k: 1 }]) {
      const submission = structuredClone(fixtures.valid);
      submission.idempotencyKey = bad;
      try {
        validatePurchaseSubmission(submission, { now: NOW });
      } catch (error) {
        ok(error instanceof PurchaseSubmissionError);
        strictEqual(error.code, "missing-field");
        strictEqual(error.key, "idempotencyKey");
        continue;
      }
      throw new Error(`mistyped key ${JSON.stringify(bad)} passed validation`);
    }
    const overlong = structuredClone(fixtures.valid);
    overlong.idempotencyKey = "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1);
    try {
      validatePurchaseSubmission(overlong, { now: NOW });
    } catch (error) {
      ok(error instanceof PurchaseSubmissionError);
      strictEqual(error.code, "invalid-value");
      strictEqual(error.key, "idempotencyKey");
      strictEqual(error.source, SOURCE);
      return;
    }
    throw new Error("overlong key passed validation");
  });

  it("validator accepts a boundary-length key and reports location-field keys as forbidden", async () => {
    const fixtures = await readPurchaseFixtures();
    const boundary = structuredClone(fixtures.valid);
    boundary.idempotencyKey = "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    strictEqual(
      validatePurchaseSubmission(boundary, { now: NOW }).idempotencyKey,
      "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH),
    );
    // An idempotencyKey that smuggles a forbidden location name still scans
    // as its own field (key name is allowlisted, value is opaque) — but a
    // submission carrying an actual location field still fails forbidden.
    const smuggled = structuredClone(fixtures.valid);
    smuggled.url = "https://example.invalid/x";
    try {
      validatePurchaseSubmission(smuggled, { now: NOW });
    } catch (error) {
      ok(error instanceof PurchaseSubmissionError);
      strictEqual(error.code, "forbidden-field");
      return;
    }
    throw new Error("forbidden location field passed validation");
  });
});

describe("purchase route idempotency-key support (TOG-6030)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postPurchase(base, listing, key) {
    const headers = {};
    if (key !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = key;
    }
    const res = await fetch(
      `${base}/listings/${listing.providerId}/${listing.modelId}/purchase`,
      { method: "POST", headers },
    );
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      requestIdHeader: res.headers.get(REQUEST_ID_HEADER),
      body: await res.json(),
    };
  }

  function assertTriageId(reply, where, expectedKeys) {
    ok(REQUEST_ID_RE.test(reply.requestIdHeader ?? ""), `${where}: x-request-id is 32 lowercase hex`);
    strictEqual(reply.body.requestId, reply.requestIdHeader, `${where}: header and body agree`);
    deepStrictEqual(
      Object.keys(reply.body).sort(),
      [...expectedKeys, "requestId"].sort(),
      `${where}: body is the expected fields plus requestId, nothing else`,
    );
  }

  it("replays the same key without a duplicate effect (one record, then replayed)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    const listing = { providerId: "northstar", modelId: "alpha-chat" };
    const key = "550e8400-e29b-41d4-a716-446655440001";

    const first = await postPurchase(base, listing, key);
    strictEqual(first.status, 403, "first: status");
    strictEqual(first.contentType, JSON_CT, "first: content type");
    strictEqual(first.body.error, "preview_only", "first: refusal copy");
    strictEqual(
      first.body.message,
      "Purchases are disabled in preview. No backend writes.",
      "first: refusal message verbatim",
    );
    strictEqual(first.body.idempotencyKey, key, "first: key echoed");
    strictEqual(first.body.replayed, undefined, "first: not a replay");
    assertTriageId(first, "first", ["error", "message", "idempotencyKey"]);

    const second = await postPurchase(base, listing, key);
    strictEqual(second.status, 403, "second: status");
    strictEqual(second.body.error, "preview_only", "second: refusal copy");
    strictEqual(second.body.idempotencyKey, key, "second: key echoed");
    strictEqual(second.body.replayed, true, "second: replay flag");
    assertTriageId(second, "second", ["error", "message", "idempotencyKey", "replayed"]);

    // The two refusals carry distinct triage ids (per-response mint) but
    // the same effect: a third hit with the same key still replays.
    ok(first.requestIdHeader !== second.requestIdHeader, "replay mints a fresh triage id");
    const third = await postPurchase(base, listing, key);
    strictEqual(third.status, 403, "third: status");
    strictEqual(third.body.replayed, true, "third: still a replay, no duplicate effect");
  });

  it("rejects the same key on a different route with 422 idempotency_key_reused", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    const key = "550e8400-e29b-41d4-a716-446655440002";

    const first = await postPurchase(base, { providerId: "northstar", modelId: "alpha-chat" }, key);
    strictEqual(first.status, 403, "first route: 403");

    const res = await fetch(`${base}/listings/northstar/image-lite/purchase`, {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: key },
    });
    strictEqual(res.status, 422, "different route, same key: 422");
    strictEqual(res.headers.get("content-type"), JSON_CT, "422: JSON content type");
    const body = await res.json();
    strictEqual(body.error, "idempotency_key_reused", "422: error name");
    strictEqual(body.key, "idempotencyKey", "422: offending key");
    ok(
      body.message.includes("fresh key"),
      `422: mismatch documented (mint a fresh key): ${body.message}`,
    );
    const header = res.headers.get(REQUEST_ID_HEADER);
    ok(REQUEST_ID_RE.test(header ?? ""), "422: triage id header");
    strictEqual(body.requestId, header, "422: header/body agree");
    deepStrictEqual(
      Object.keys(body).sort(),
      ["error", "key", "message", "requestId"],
      "422: no extra fields",
    );
  });

  it("fails closed 400 on overlong keys and keeps the refusal copy exact", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    const res = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) },
    });
    strictEqual(res.status, 400, "overlong key: 400");
    const body = await res.json();
    strictEqual(body.error, "invalid_idempotency_key", "400: error name");
    strictEqual(body.code, "invalid-value", "400: validator vocab code");
    strictEqual(body.key, "idempotencyKey", "400: offending key");
    assertTriageId(
      { requestIdHeader: res.headers.get(REQUEST_ID_HEADER), body },
      "overlong key",
      ["error", "code", "key", "source", "message"],
    );

    // Boundary-length keys are accepted and echoed.
    const boundary = "k".repeat(MAX_IDEMPOTENCY_KEY_LENGTH);
    const accepted = await postPurchase(
      base,
      { providerId: "northstar", modelId: "alpha-chat" },
      boundary,
    );
    strictEqual(accepted.status, 403, "boundary key: 403");
    strictEqual(accepted.body.idempotencyKey, boundary, "boundary key: echoed");
  });

  it("fails closed 400 on blank keys, matching the validator (never stored or echoed)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    for (const blank of ["", "   "]) {
      const res = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
        method: "POST",
        headers: { [IDEMPOTENCY_KEY_HEADER]: blank },
      });
      strictEqual(res.status, 400, `blank key ${JSON.stringify(blank)}: 400`);
      const body = await res.json();
      strictEqual(body.error, "invalid_idempotency_key", "400: error name");
      strictEqual(body.code, "missing-field", "400: validator vocab code");
      strictEqual(body.key, "idempotencyKey", "400: offending key");
      assertTriageId(
        { requestIdHeader: res.headers.get(REQUEST_ID_HEADER), body },
        `blank key ${JSON.stringify(blank)}`,
        ["error", "code", "key", "source", "message"],
      );
    }
  });

  it("refuses without a key exactly as before (no echo field, triage id intact)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    const reply = await postPurchase(base, { providerId: "northstar", modelId: "alpha-chat" });
    strictEqual(reply.status, 403, "no key: 403");
    strictEqual(reply.contentType, JSON_CT, "no key: JSON content type");
    deepStrictEqual(
      { error: reply.body.error, message: reply.body.message },
      {
        error: "preview_only",
        message: "Purchases are disabled in preview. No backend writes.",
      },
      "no key: refusal copy byte-identical",
    );
    strictEqual(reply.body.idempotencyKey, undefined, "no key: no echo field");
    strictEqual(reply.body.replayed, undefined, "no key: no replay flag");
    assertTriageId(reply, "no key", ["error", "message"]);
  });

  it("never lets a key mask the 404/405 gates", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { logger: () => {} });
    const key = "550e8400-e29b-41d4-a716-446655440003";

    // Unknown listing 404s first, even with a key.
    const miss = await fetch(`${base}/listings/northstar/nope/purchase`, {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: key },
    });
    strictEqual(miss.status, 404, "unknown listing with key: 404");
    strictEqual((await miss.json()).error, "listing_not_found", "404: shape");

    // Wrong method 405s, even with a key — and does not consume the key:
    // the same key on a real POST afterwards is a first effect, not 422.
    const wrong = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
      method: "PUT",
      headers: { [IDEMPOTENCY_KEY_HEADER]: key },
    });
    strictEqual(wrong.status, 405, "wrong method with key: 405");
    strictEqual(wrong.headers.get("allow"), "POST", "405: Allow intact");

    const after = await postPurchase(base, { providerId: "northstar", modelId: "alpha-chat" }, key);
    strictEqual(after.status, 403, "key after 404/405 gates: 403 first effect");
    strictEqual(after.body.replayed, undefined, "gates never consumed the key");
  });
});
