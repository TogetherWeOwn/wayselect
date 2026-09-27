// Per-model eligibility display for the Wayselect catalog surface (TOG-5221).
//
// Read-only display over existing capability-check output: stub listings are
// fed through `evaluateEligibility` from src/eligibility.js with a frozen
// synthetic preview request, and the result maps to one of three display
// states — granted, blocked, unknown. Unknown (missing capability data, or a
// malformed evaluation) fails closed: it renders "not selectable" copy and is
// never treated as eligible. No network, no credentials, no backend writes.

import { evaluateEligibility } from "../src/eligibility.js";

export const ELIGIBILITY_STATE = Object.freeze({
  GRANTED: "granted",
  BLOCKED: "blocked",
  UNKNOWN: "unknown",
});

// Frozen synthetic preview request. Mirrors fixtures/request.synthetic.json
// `selection` so the preview explains the same capability check the CLI demos:
// operation `chat`, required capability `toolUse`, explicit provider allowlist.
export const PREVIEW_ELIGIBILITY_REQUEST = Object.freeze({
  operation: "chat",
  requiredCapabilities: Object.freeze(["toolUse"]),
  providerAllowlist: Object.freeze(["northstar", "orbit"]),
});

// Frozen synthetic evaluation options. Mirrors fixtures/request.synthetic.json
// (`evaluationTime`, `maxEvidenceAgeHours`) via support/helpers.js.
// TOG-5299: the stub preview has no catalog provenance to probe, so it
// carries the explicit catalog opt-out rather than silently skipping
// freshness enforcement.
export const PREVIEW_ELIGIBILITY_OPTIONS = Object.freeze({
  now: new Date("2026-09-24T12:00:00.000Z"),
  maxEvidenceAgeMs: 72 * 60 * 60 * 1000,
  skipCatalogCheck: true,
});

// Frozen synthetic support context per stub route. Mirrors
// fixtures/configuration.synthetic.json. Routes absent from this map fall back
// to `catalogued` with no configured operations and no evidence (fail closed:
// present in the catalog only, never granted).
export const PREVIEW_SUPPORT_CONTEXT = Object.freeze({
  "northstar/alpha-chat": Object.freeze({
    supportState: "configured",
    operations: Object.freeze(["chat"]),
    observedAt: "2026-09-23T12:00:00.000Z",
  }),
  "northstar/image-lite": Object.freeze({
    supportState: "configured",
    operations: Object.freeze(["vision-chat"]),
    observedAt: "2026-09-23T12:00:00.000Z",
  }),
  "northstar/unknown-tools": Object.freeze({
    supportState: "configured",
    operations: Object.freeze(["chat"]),
    observedAt: "2026-09-23T12:00:00.000Z",
  }),
});

const FALLBACK_SUPPORT_CONTEXT = Object.freeze({
  supportState: "catalogued",
  operations: Object.freeze([]),
  observedAt: null,
});

// Reasons that mean "we do not know", not "we know it is excluded". Any
// evaluation carrying one of these renders as unknown with fail-closed copy.
const UNKNOWN_REASON_SIGNALS = Object.freeze([
  "missing-capability:",
  "missing-evidence",
  "invalid-evidence",
  "future-evidence",
  "stale-evidence",
  "stale-catalog",
  "future-catalog",
]);

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

// Same derivation as normalizeCatalog in src/catalog.js: operation claims come
// from modalities, capability flags default to null (unknown) when absent.
function catalogOperationsFor(modalities) {
  const input = modalities?.input ?? [];
  const output = modalities?.output ?? [];
  const operations = [];
  if (input.includes("text") && output.includes("text")) {
    operations.push("chat");
  }
  if (input.includes("image") && output.includes("text")) {
    operations.push("vision-chat");
  }
  return operations;
}

function capabilitiesFor(entry, modalities) {
  const input = modalities?.input ?? [];
  const output = modalities?.output ?? [];
  return {
    attachment: booleanOrNull(entry.attachment),
    reasoning: booleanOrNull(entry.reasoning),
    toolUse: booleanOrNull(entry.tool_call),
    structuredOutput: booleanOrNull(entry.structured_output),
    imageInput: input.includes("image"),
    textInput: input.includes("text"),
    textOutput: output.includes("text"),
  };
}

export function candidateFromStubListing(listing) {
  const routeId = `${listing.providerId}/${listing.modelId}`;
  const support = PREVIEW_SUPPORT_CONTEXT[routeId] ?? FALLBACK_SUPPORT_CONTEXT;
  const modalities = listing.entry?.modalities ?? { input: [], output: [] };
  const candidate = {
    routeId,
    providerId: listing.providerId,
    modelId: listing.modelId,
    supportState: support.supportState,
    catalogOperations: catalogOperationsFor(modalities),
    configuredOperations: [...support.operations],
    capabilities: capabilitiesFor(listing.entry ?? {}, modalities),
    evidence: support.observedAt ? { observedAt: support.observedAt } : null,
  };
  if (listing.entry?.cost !== undefined) {
    candidate.rates = {
      inputPerMillion: listing.entry.cost.input,
      outputPerMillion: listing.entry.cost.output,
    };
  }
  return candidate;
}

export function evaluateListingEligibility(
  listing,
  request = PREVIEW_ELIGIBILITY_REQUEST,
  options = PREVIEW_ELIGIBILITY_OPTIONS,
) {
  const [evaluation] = evaluateEligibility([candidateFromStubListing(listing)], request, options);
  return evaluation;
}

export function evaluateListingsEligibility(
  listings,
  request = PREVIEW_ELIGIBILITY_REQUEST,
  options = PREVIEW_ELIGIBILITY_OPTIONS,
) {
  const candidates = listings.map(candidateFromStubListing);
  const evaluations = evaluateEligibility(candidates, request, options);
  const byRoute = new Map();
  for (const evaluation of evaluations) {
    byRoute.set(evaluation.routeId, evaluation);
  }
  return byRoute;
}

// Map existing capability-check output to a display state. Anything malformed
// or missing fails closed to unknown — never to granted.
export function classifyEligibilityDisplay(evaluation) {
  if (
    evaluation === null ||
    typeof evaluation !== "object" ||
    Array.isArray(evaluation) ||
    typeof evaluation.eligible !== "boolean" ||
    !Array.isArray(evaluation.reasons)
  ) {
    return ELIGIBILITY_STATE.UNKNOWN;
  }
  // Defense-in-depth invariant (TOG-5298): the real evaluator guarantees
  // eligible = reasons.length === 0, so eligible:true with non-empty reasons
  // is forged or compromised output — fail closed to unknown, never granted.
  if (evaluation.eligible === true) {
    return evaluation.reasons.length === 0
      ? ELIGIBILITY_STATE.GRANTED
      : ELIGIBILITY_STATE.UNKNOWN;
  }
  if (evaluation.reasons.length === 0) {
    return ELIGIBILITY_STATE.UNKNOWN;
  }
  // Fail closed: non-string reasons are malformed evaluator output — unknown,
  // never blocked.
  if (evaluation.reasons.some((reason) => typeof reason !== "string")) {
    return ELIGIBILITY_STATE.UNKNOWN;
  }
  const hasUnknownSignal = evaluation.reasons.some((reason) =>
    UNKNOWN_REASON_SIGNALS.some((signal) => reason.startsWith(signal)),
  );
  return hasUnknownSignal ? ELIGIBILITY_STATE.UNKNOWN : ELIGIBILITY_STATE.BLOCKED;
}

export function previewRequestSummary(
  request = PREVIEW_ELIGIBILITY_REQUEST,
) {
  const capabilities = request.requiredCapabilities.join(", ") || "none";
  const providers = request.providerAllowlist.join(", ");
  return `operation ${request.operation}, required capabilities ${capabilities}, providers ${providers}`;
}

// Human copy per state. Unknown copy is fail-closed: not selectable until
// capability data is available.
export function describeEligibility(
  evaluation,
  request = PREVIEW_ELIGIBILITY_REQUEST,
) {
  const state = classifyEligibilityDisplay(evaluation);
  const reasons =
    evaluation !== null &&
    typeof evaluation === "object" &&
    Array.isArray(evaluation.reasons)
      ? [...evaluation.reasons]
      : [];
  const summary = previewRequestSummary(request);
  if (state === ELIGIBILITY_STATE.GRANTED) {
    return Object.freeze({
      state,
      label: "Granted",
      headline: `Eligible for the preview capability check (${summary}).`,
      reasons: Object.freeze([]),
    });
  }
  if (state === ELIGIBILITY_STATE.BLOCKED) {
    return Object.freeze({
      state,
      label: "Blocked",
      headline: `Not eligible for the preview capability check (${summary}).`,
      reasons: Object.freeze(reasons),
    });
  }
  return Object.freeze({
    state,
    label: "Unknown",
    headline:
      "Eligibility unknown — capability data unavailable; " +
      "not selectable until capability data is available.",
    reasons: Object.freeze(reasons),
  });
}
