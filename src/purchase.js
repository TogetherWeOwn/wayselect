// Purchase-intake validator for the Wayselect buyer-onboarding slice
// (TOG-5154 test leaf; buyer spec: TOG-4869 click-path
// listing -> eligibility check -> confirm -> receipt).
//
// Sibling to src/sellerSubmission.js (TOG-5118). Pure, fixture-only, no
// backend: a purchase submission in, a frozen normalized purchase out.
// Anything malformed is rejected fail-closed with a typed
// PurchaseSubmissionError carrying a stable `code`, the offending `key`
// path, and the provenance `source` (every rejection names the offending
// key + provenance source before anything renders).
//
// Accepted envelope (exact keys, no additional properties at any level):
//   providerId  — listing provider (non-empty string)
//   modelId     — listing id (non-empty string)
//   buyerId     — buyer identity (non-empty string)
//   confirm     — explicit purchase confirmation; must be boolean true
//                 (the click-path confirm step; absent/false never proceeds)
//   idempotencyKey — optional client-generated opaque token (UUID
//                 recommended, ≤256 chars); echoed back verbatim so a
//                 retried submission can prove it is the same attempt.
//                 Absent means no dedup claim (normalized to null).
//   provenance  — { source, fetchedAt } + optional etag; required, always
//
// Executable location fields (url, endpoint, baseUrl, apiUrl) are never
// accepted anywhere in a submission.

const SUBMISSION_KEYS = new Set([
  "providerId",
  "modelId",
  "buyerId",
  "confirm",
  "idempotencyKey",
  "provenance",
]);
const PROVENANCE_KEYS = new Set(["source", "fetchedAt", "etag"]);
const FORBIDDEN_LOCATION_KEYS = new Set(["url", "endpoint", "baseUrl", "apiUrl"]);

import {
  MAX_BUYER_ID_LENGTH,
  MAX_ETAG_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_MODEL_ID_LENGTH,
  MAX_PROVIDER_ID_LENGTH,
  ROUTE_ID_PATTERN,
  SYNTHETIC_SOURCE_PREFIX,
  isRouteId,
  isSyntheticSource,
  nowMs,
} from "./intakeLimits.js";

export class PurchaseSubmissionError extends Error {
  constructor(message, { code, key = null, source = null } = {}) {
    super(message);
    this.name = "PurchaseSubmissionError";
    this.code = code;
    this.key = key;
    this.source = source;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceTag(source) {
  return source === null || source === undefined ? "provenance missing" : `source ${source}`;
}

function fail(code, key, source, detail) {
  throw new PurchaseSubmissionError(`[${sourceTag(source)}] ${detail}`, { code, key, source });
}

function requireObject(value, label, key, source) {
  if (!isPlainObject(value)) {
    fail("invalid-type", key, source, `${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label, key, source) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("missing-field", key, source, `${label} must be a non-empty string`);
  }
  return value;
}

// S3 (TOG-5476): length-capped non-empty string. Overlong values fail
// closed with `invalid-value` so callers can distinguish "absent" from
// "too long".
function requireCappedString(value, label, key, source, maxLength) {
  requireNonEmptyString(value, label, key, source);
  if (value.length > maxLength) {
    fail("invalid-value", key, source, `${label} must be at most ${maxLength} characters`);
  }
  return value;
}

// S3 (TOG-5476): route id allowlist + length cap (lowercase slug ids,
// `[a-z0-9][a-z0-9-]{0,63}`).
function requireRouteId(value, label, key, source, maxLength) {
  requireCappedString(value, label, key, source, maxLength);
  if (!isRouteId(value)) {
    fail(
      "invalid-value",
      key,
      source,
      `${label} must match ${ROUTE_ID_PATTERN} (lowercase slug id)`,
    );
  }
  return value;
}

function assertKnownKeys(value, allowedKeys, label, key, source) {
  for (const field of Object.keys(value)) {
    if (!allowedKeys.has(field)) {
      fail("unknown-field", `${key}.${field}`, source, `${label} contains unknown field: ${field}`);
    }
  }
}

// TOG-8429: explicit-stack scan. Same fix as src/sellerSubmission.js — the
// old recursion spent one call frame per nesting level, so deeply-nested
// input exhausted the stack with a RangeError that escapes the typed-error
// catch (here callers catch `instanceof PurchaseSubmissionError`). Not
// HTTP-reachable today (the purchase route ignores bodies), but the buyer
// acceptance scripts run this validator, so the same crash applied there.
// The frame stack below replays the old recursion's depth-first pre-order
// exactly, so the first forbidden field reported is byte-identical.
function assertNoLocationFields(value, path, source) {
  const frames = [{ value, path, entries: null, index: 0 }];
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.value === null || typeof frame.value !== "object") {
      frames.pop();
      continue;
    }
    if (frame.entries === null) {
      frame.entries = Object.entries(frame.value);
    }
    if (frame.index >= frame.entries.length) {
      frames.pop();
      continue;
    }
    const [field, nested] = frame.entries[frame.index];
    frame.index += 1;
    const key = `${frame.path}.${field}`;
    if (FORBIDDEN_LOCATION_KEYS.has(field)) {
      fail(
        "forbidden-field",
        key,
        source,
        `submission must not contain executable location field: ${key}`,
      );
    }
    frames.push({ value: nested, path: key, entries: null, index: 0 });
  }
}

function extractSource(submission) {
  const provenance = submission !== null && typeof submission === "object" ? submission.provenance : null;
  if (isPlainObject(provenance) && typeof provenance.source === "string" && provenance.source !== "") {
    return provenance.source;
  }
  return null;
}

// TOG-6030: optional idempotency-key normalizer. Absent means the client
// makes no dedup claim (normalized to null); present must be a non-empty
// opaque string ≤ MAX_IDEMPOTENCY_KEY_LENGTH (UUID recommended, never
// echoed into logs, only back to the client that sent it). Non-strings and
// overlong values fail closed with the validator's stable vocab so a retry
// bug surfaces as a rejection, never a silent duplicate.
function normalizeIdempotencyKey(value, source) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail("missing-field", "idempotencyKey", source, "idempotencyKey must be a non-empty string");
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    fail(
      "invalid-value",
      "idempotencyKey",
      source,
      `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  return value;
}

function normalizeConfirm(value, source) {
  if (value === undefined) {
    fail("missing-field", "confirm", source, "submission.confirm is required");
  }
  if (typeof value !== "boolean") {
    fail("invalid-type", "confirm", source, "submission.confirm must be a boolean");
  }
  if (value !== true) {
    fail(
      "unconfirmed",
      "confirm",
      source,
      "submission.confirm must be true; unconfirmed purchases never proceed",
    );
  }
  return true;
}

function normalizeProvenance(value, options = {}) {
  const provenance = requireObject(value, "provenance", "provenance", null);
  const rawSource =
    typeof provenance.source === "string" && provenance.source !== ""
      ? provenance.source
      : null;
  // Forbidden location fields are reported as forbidden even inside
  // provenance (this runs before the whole-submission scan in the caller).
  assertNoLocationFields(provenance, "provenance", rawSource);
  assertKnownKeys(provenance, PROVENANCE_KEYS, "provenance", "provenance", rawSource);

  // S3 (TOG-5476): provenance.source must be a synthetic fixture source.
  const source = requireNonEmptyString(
    provenance.source,
    "provenance.source",
    "provenance.source",
    null,
  );
  if (!isSyntheticSource(source)) {
    fail(
      "invalid-value",
      "provenance.source",
      null,
      `provenance.source must start with ${JSON.stringify(SYNTHETIC_SOURCE_PREFIX)}`,
    );
  }
  const fetchedAt = requireNonEmptyString(
    provenance.fetchedAt,
    "provenance.fetchedAt",
    "provenance.fetchedAt",
    source,
  );
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    fail(
      "invalid-value",
      "provenance.fetchedAt",
      source,
      "provenance.fetchedAt must be an ISO timestamp",
    );
  }
  // S3 (TOG-5476): future fetchedAt is rejected fail-closed. `now` is
  // injectable for deterministic tests.
  const referenceMs = nowMs(options.now);
  if (!Number.isFinite(referenceMs)) {
    fail(
      "invalid-type",
      "provenance.fetchedAt",
      source,
      "options.now must be a valid date when present",
    );
  }
  const FUTURE_TOLERANCE_MS = 60 * 1000;
  if (fetchedAtMs - referenceMs > FUTURE_TOLERANCE_MS) {
    fail(
      "invalid-value",
      "provenance.fetchedAt",
      source,
      "provenance.fetchedAt must not be in the future",
    );
  }
  const etag =
    provenance.etag === undefined
      ? null
      : requireCappedString(
          provenance.etag,
          "provenance.etag",
          "provenance.etag",
          source,
          MAX_ETAG_LENGTH,
        );

  return Object.freeze({ source, fetchedAt: new Date(fetchedAtMs).toISOString(), etag });
}

export function validatePurchaseSubmission(submission, options = {}) {
  const source = extractSource(submission);
  const input = requireObject(submission, "submission", "submission", source);

  if (input.provenance === undefined) {
    fail("missing-provenance", "provenance", source, "submission.provenance is required");
  }
  const provenance = normalizeProvenance(input.provenance, options);
  const provenanceSource = provenance.source;

  // Executable location fields are never accepted, at any depth.
  // Scanned before unknown-field checks so a forbidden field is always
  // reported as forbidden, even where it is also unknown.
  assertNoLocationFields(input, "submission", provenanceSource);
  assertKnownKeys(input, SUBMISSION_KEYS, "submission", "submission", provenanceSource);

  const providerId = requireRouteId(
    input.providerId,
    "providerId",
    "providerId",
    provenanceSource,
    MAX_PROVIDER_ID_LENGTH,
  );
  const modelId = requireRouteId(
    input.modelId,
    "modelId",
    "modelId",
    provenanceSource,
    MAX_MODEL_ID_LENGTH,
  );
  // S3 (TOG-5476): buyer cap 120 chars (matches the offer forward-contract
  // O5 rule in docs/wayselect-seller-acceptance.md).
  const buyerId = requireCappedString(
    input.buyerId,
    "buyerId",
    "buyerId",
    provenanceSource,
    MAX_BUYER_ID_LENGTH,
  );
  normalizeConfirm(input.confirm, provenanceSource);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, provenanceSource);

  return Object.freeze({
    routeId: `${providerId}/${modelId}`,
    providerId,
    modelId,
    buyerId,
    idempotencyKey,
    provenance,
  });
}
