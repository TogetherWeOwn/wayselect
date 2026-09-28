// Shared intake-hardening limits for Wayselect seller/purchase validators
// (TOG-5476, S3 slice of the TOG-5465 §4 preview security checklist).
//
// Pure constants + predicates, no error type of its own: each validator keeps
// its typed error (SellerSubmissionError / PurchaseSubmissionError) and maps
// these limits to its stable `code` vocabulary (fail-closed `invalid-value`).

// S3 length caps: provider/model ≤64, buyer ≤120, description ≤4k, etag ≤256.
export const MAX_PROVIDER_ID_LENGTH = 64;
export const MAX_MODEL_ID_LENGTH = 64;
export const MAX_BUYER_ID_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 4000;
export const MAX_ETAG_LENGTH = 256;

// S3 allowlist: providerId/modelId/entry.id are lowercase slug ids.
export const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// S3 provenance boundary: intake only accepts synthetic fixture sources,
// mirroring the staging-only snapshot boundary (`synthetic://` prefix in
// src/snapshot.js and src/provenanceAudit.js).
export const SYNTHETIC_SOURCE_PREFIX = "synthetic://";

// S3 body cap for future POST routes (~64KB; enforced in web/jsonBody.js).
export const MAX_JSON_BODY_BYTES = 64 * 1024;

// R4-06 read bound for POST routes (total deadline for one streamed body in
// web/jsonBody.js). A ≤64KB body that cannot complete within 10s is a
// trickling/stalled sender, not a slow client — fail closed with
// `body_timeout` (408 at the route) instead of hanging the socket.
export const MAX_JSON_BODY_READ_MS = 10_000;

// TOG-7307 gateway intake caps: the in-process chat-completions handler
// (src/gateway.js) is not behind the HTTP JSON body gate, so it enforces
// its own message count/size bounds fail-closed with 400
// (`invalid_request_error`). Per-message text is measured after content-part
// normalization (joined text parts); the total is the sum over messages.
// Budgets mirror the ~64KB body cap: 32 messages × 16k chars each, with a
// 64k combined ceiling so a single request cannot balloon word-count,
// prompt assembly, or the fake-transport payload.
export const MAX_GATEWAY_MESSAGES = 32;
export const MAX_GATEWAY_MESSAGE_CHARS = 16_000;
export const MAX_GATEWAY_TOTAL_CHARS = 64_000;

export function isRouteId(value) {
  return typeof value === "string" && ROUTE_ID_PATTERN.test(value);
}

export function isSyntheticSource(value) {
  return typeof value === "string" && value.startsWith(SYNTHETIC_SOURCE_PREFIX);
}

// Coerce an `options.now` reference time to epoch ms. `undefined` means
// "now". Returns NaN when the value is not a valid date; callers fail
// closed on NaN with their own typed error.
export function nowMs(value) {
  if (value === undefined) {
    return Date.now();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Date.parse(value);
  }
  return Number.NaN;
}
