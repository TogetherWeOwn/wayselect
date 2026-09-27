import { SupportState } from "./support.js";
import { checkCatalogFreshness } from "./freshness.js";

const ELIGIBLE_STATES = new Set([
  SupportState.CONFIGURED,
  SupportState.CONFORMANCE_TESTED,
]);

export class EligibilityRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "EligibilityRequestError";
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EligibilityRequestError(`${label} must be a non-empty string`);
  }
  return value;
}

function uniqueStringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new EligibilityRequestError(`${label} must be an array of non-empty strings`);
  }
  const normalized = [...new Set(value)].sort();
  if (!allowEmpty && normalized.length === 0) {
    throw new EligibilityRequestError(`${label} must contain at least one explicit value`);
  }
  return normalized;
}

function normalizeOptions(options) {
  const now = options?.now instanceof Date ? options.now : new Date(options?.now);
  if (!Number.isFinite(now.getTime())) {
    throw new EligibilityRequestError("options.now must be a valid date");
  }

  const maxEvidenceAgeMs = options?.maxEvidenceAgeMs;
  if (!Number.isFinite(maxEvidenceAgeMs) || maxEvidenceAgeMs < 0) {
    throw new EligibilityRequestError("options.maxEvidenceAgeMs must be a non-negative number");
  }

  const catalog = options?.catalog ?? null;
  let catalogProbe = null;
  if (catalog !== null) {
    if (!Number.isFinite(options?.maxCatalogAgeMs) || options.maxCatalogAgeMs < 0) {
      throw new EligibilityRequestError(
        "options.maxCatalogAgeMs must be a non-negative number",
      );
    }
    catalogProbe = checkCatalogFreshness(catalog, {
      now,
      maxCatalogAgeMs: options.maxCatalogAgeMs,
    });
  }

  return { now, maxEvidenceAgeMs, catalogProbe };
}

export function normalizeSelectionRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new EligibilityRequestError("request must be an object");
  }

  return Object.freeze({
    operation: nonEmptyString(request.operation, "request.operation"),
    requiredCapabilities: Object.freeze(
      uniqueStringArray(
        request.requiredCapabilities === undefined ? [] : request.requiredCapabilities,
        "request.requiredCapabilities",
      ),
    ),
    providerAllowlist: Object.freeze(
      uniqueStringArray(request.providerAllowlist, "request.providerAllowlist", {
        allowEmpty: false,
      }),
    ),
  });
}

function evidenceReasons(candidate, now, maxEvidenceAgeMs) {
  if (!candidate.evidence) {
    return ["missing-evidence"];
  }

  const rawObservedAt =
    candidate.evidence !== null && typeof candidate.evidence === "object"
      ? candidate.evidence.observedAt
      : undefined;
  const observedAt = typeof rawObservedAt === "string" ? Date.parse(rawObservedAt) : Number.NaN;
  if (!Number.isFinite(observedAt)) {
    return ["invalid-evidence"];
  }
  const ageMs = now.getTime() - observedAt;
  if (ageMs < 0) {
    return ["future-evidence"];
  }
  if (ageMs > maxEvidenceAgeMs) {
    return ["stale-evidence"];
  }
  return [];
}

function requireCandidate(candidate, index) {
  const label = `candidates[${index}]`;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new EligibilityRequestError(`${label} must be an object`);
  }
  for (const field of ["routeId", "providerId", "modelId", "supportState"]) {
    if (typeof candidate[field] !== "string" || candidate[field].trim() === "") {
      throw new EligibilityRequestError(`${label}.${field} must be a non-empty string`);
    }
  }
  for (const field of ["catalogOperations", "configuredOperations"]) {
    const value = candidate[field];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || item === "")
    ) {
      throw new EligibilityRequestError(
        `${label}.${field} must be an array of non-empty strings`,
      );
    }
  }
  if (
    candidate.capabilities === null ||
    typeof candidate.capabilities !== "object" ||
    Array.isArray(candidate.capabilities)
  ) {
    throw new EligibilityRequestError(`${label}.capabilities must be an object`);
  }
  if (candidate.rates !== null && candidate.rates !== undefined) {
    if (typeof candidate.rates !== "object" || Array.isArray(candidate.rates)) {
      throw new EligibilityRequestError(`${label}.rates must be an object when present`);
    }
  }
}

export function evaluateEligibility(candidates, requestInput, optionsInput) {
  if (!Array.isArray(candidates)) {
    throw new EligibilityRequestError("candidates must be an array");
  }
  candidates.forEach(requireCandidate);
  const request = normalizeSelectionRequest(requestInput);
  const { now, maxEvidenceAgeMs, catalogProbe } = normalizeOptions(optionsInput);
  const allowedProviders = new Set(request.providerAllowlist);

  return Object.freeze(
    [...candidates]
      .sort((left, right) => left.routeId.localeCompare(right.routeId))
      .map((candidate) => {
        if (catalogProbe !== null && !catalogProbe.fresh) {
          const catalogReason = catalogProbe.ageMs < 0 ? "future-catalog" : "stale-catalog";
          return Object.freeze({
            routeId: candidate.routeId,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            supportState: candidate.supportState,
            eligible: false,
            reasons: Object.freeze([catalogReason]),
            rates: candidate.rates,
          });
        }

        const reasons = [];

        if (!ELIGIBLE_STATES.has(candidate.supportState)) {
          reasons.push(`support-state:${candidate.supportState}`);
        }
        if (!allowedProviders.has(candidate.providerId)) {
          reasons.push("provider-not-allowed");
        }
        if (!candidate.catalogOperations.includes(request.operation)) {
          reasons.push("operation-not-catalogued");
        }
        if (!candidate.configuredOperations.includes(request.operation)) {
          reasons.push("operation-not-configured");
        }

        for (const capability of request.requiredCapabilities) {
          const value = candidate.capabilities[capability];
          if (value === undefined || value === null) {
            reasons.push(`missing-capability:${capability}`);
          } else if (value !== true) {
            reasons.push(`unsupported-capability:${capability}`);
          }
        }

        if (ELIGIBLE_STATES.has(candidate.supportState)) {
          reasons.push(...evidenceReasons(candidate, now, maxEvidenceAgeMs));
        }

        return Object.freeze({
          routeId: candidate.routeId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          supportState: candidate.supportState,
          eligible: reasons.length === 0,
          reasons: Object.freeze(reasons),
          rates: candidate.rates,
        });
      }),
  );
}
