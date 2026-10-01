// Buyer trust-signal dispute stub for the Wayselect preview slice (TOG-8061,
// spec docs/wayselect-buyer-trust-signals.md §5–§6).
//
// Pure validation plus a tiny in-memory store. Disputes are JSON-only stub
// data: no auth, no triage, no resolution, no refund path (accepted gaps G2,
// G3 in the spec). Restart clears; ids are deterministic per listing per
// process (`dispute-1`, …). Anything malformed fails closed with
// `invalid_dispute` — never a stored partial record, never a charge (D10).
//
// Zero dependencies: plain objects only.

import { MAX_BUYER_ID_LENGTH } from "../src/intakeLimits.js";

// v1 dispute reasons (spec §5 D5, shape §6): exact enum, exact keys.
export const VALID_DISPUTE_REASONS = Object.freeze([
  "not_as_described",
  "never_delivered",
  "billing_issue",
  "other",
]);

const DISPUTE_BODY_KEYS = new Set(["buyer", "reason"]);

// Fail-closed validator for the POST disputes body. Returns
// `{ok:true, value:{buyer, reason}}` with the buyer trimmed, or
// `{ok:false, message}` naming the failure (non-object body, unknown
// fields, non-string or out-of-range buyer, unknown reason). The route maps
// every rejection onto `{error:"invalid_dispute", …}` and always names the
// valid reasons there, so this message stays human-readable rather than
// machine-shaped.
export function validateDisputeBody(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      message: "Dispute body must be a JSON object carrying buyer and reason.",
    };
  }
  const unknown = Object.keys(value).find((key) => !DISPUTE_BODY_KEYS.has(key));
  if (unknown !== undefined) {
    return {
      ok: false,
      message: `Unknown dispute field ${JSON.stringify(unknown)}: only buyer and reason are accepted.`,
    };
  }
  const { buyer, reason } = value;
  if (typeof buyer !== "string") {
    return { ok: false, message: "Dispute buyer must be a string." };
  }
  const trimmed = buyer.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_BUYER_ID_LENGTH) {
    return {
      ok: false,
      message: `Dispute buyer must be 1-${MAX_BUYER_ID_LENGTH} characters after trimming.`,
    };
  }
  if (typeof reason !== "string" || !VALID_DISPUTE_REASONS.includes(reason)) {
    return {
      ok: false,
      message: `Dispute reason must be one of: ${VALID_DISPUTE_REASONS.join(", ")}.`,
    };
  }
  return { ok: true, value: { buyer: trimmed, reason } };
}

// In-memory per-listing dispute log. One store per app instance (wired in
// web/server.js `createApp`, next to the seller intents): restart clears,
// and ids restart at `dispute-1` per listing. Records are frozen on write;
// `list` returns a copy so callers can never mutate the log.
export function createDisputeStore() {
  const records = new Map();
  return {
    list(routeId) {
      return [...(records.get(routeId) ?? [])];
    },
    file(routeId, { buyer, reason }) {
      const entries = records.get(routeId) ?? [];
      const dispute = Object.freeze({
        id: `dispute-${entries.length + 1}`,
        listing: routeId,
        buyer,
        reason,
        status: "open",
      });
      entries.push(dispute);
      records.set(routeId, entries);
      return dispute;
    },
  };
}
