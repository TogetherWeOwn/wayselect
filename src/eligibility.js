import { SupportState } from "./support.js";
import { checkCatalogFreshness } from "./freshness.js";
import { compareRouteIds } from "./routeIds.js";

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
  const skipCatalogCheck = options?.skipCatalogCheck ?? false;
  if (skipCatalogCheck !== true && skipCatalogCheck !== false) {
    throw new EligibilityRequestError(
      "options.skipCatalogCheck must be a boolean (true to explicitly opt out of catalog freshness)",
    );
  }
  const hasMaxCatalogAgeMs = options?.maxCatalogAgeMs !== undefined;
  if (catalog === null) {
    // TOG-5299: catalog-less calls used to skip the staleness gate silently
    // (catalogProbe null => stale/future-catalog branch never runs). Omission
    // is now loud: pass an explicit catalog, or explicitly opt out.
    if (hasMaxCatalogAgeMs) {
      throw new EligibilityRequestError(
        "options.catalog is required when options.maxCatalogAgeMs is set",
      );
    }
    if (skipCatalogCheck !== true) {
      throw new EligibilityRequestError(
        "options.catalog is required for catalog freshness enforcement, " +
          "or pass options.skipCatalogCheck:true to explicitly opt out",
      );
    }
    return { now, maxEvidenceAgeMs, catalogProbe: null };
  }
  // When a catalog is present the freshness gate always runs; an inherited
  // skipCatalogCheck from a shared base options object must not silently
  // disable it, so the flag is ignored here (it only matters when catalog
  // is absent).
  if (!Number.isFinite(options?.maxCatalogAgeMs) || options.maxCatalogAgeMs < 0) {
    throw new EligibilityRequestError(
      "options.maxCatalogAgeMs must be a non-negative number",
    );
  }
  const catalogProbe = checkCatalogFreshness(catalog, {
    now,
    maxCatalogAgeMs: options.maxCatalogAgeMs,
  });

  return { now, maxEvidenceAgeMs, catalogProbe };
}

// TOG-4794: typed capability requirements. Each requirement is optional;
// unknown requirement names are rejected at the boundary (fail closed).
// `false` on a boolean flag means "no constraint" — only `true` requires.
const REQUIREMENT_KEYS = new Set([
  "inputModalities",
  "outputModalities",
  "minContextWindow",
  "maxOutputTokens",
  "toolCalling",
  "structuredOutput",
  "reasoning",
]);

const BOOLEAN_CAPABILITY_FOR_FLAG = {
  toolCalling: "toolUse",
  structuredOutput: "structuredOutput",
  reasoning: "reasoning",
};

// selectRoute normalizes the request before evaluateEligibility normalizes
// it again, so null (the normalized "absent") must round-trip like undefined.
function optionalTokenThreshold(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new EligibilityRequestError(`${label} must be a non-negative integer when present`);
  }
  return value;
}

function optionalRequirementFlag(value, label) {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new EligibilityRequestError(`${label} must be a boolean when present`);
  }
  return value;
}

function normalizeRequirements(value) {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EligibilityRequestError("request.requirements must be an object when present");
  }
  for (const key of Object.keys(value)) {
    if (!REQUIREMENT_KEYS.has(key)) {
      throw new EligibilityRequestError(
        `request.requirements contains unknown requirement: ${key}`,
      );
    }
  }

  return Object.freeze({
    inputModalities: Object.freeze(
      uniqueStringArray(value.inputModalities ?? [], "request.requirements.inputModalities"),
    ),
    outputModalities: Object.freeze(
      uniqueStringArray(value.outputModalities ?? [], "request.requirements.outputModalities"),
    ),
    minContextWindow: optionalTokenThreshold(
      value.minContextWindow,
      "request.requirements.minContextWindow",
    ),
    maxOutputTokens: optionalTokenThreshold(
      value.maxOutputTokens,
      "request.requirements.maxOutputTokens",
    ),
    toolCalling: optionalRequirementFlag(value.toolCalling, "request.requirements.toolCalling"),
    structuredOutput: optionalRequirementFlag(
      value.structuredOutput,
      "request.requirements.structuredOutput",
    ),
    reasoning: optionalRequirementFlag(value.reasoning, "request.requirements.reasoning"),
  });
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
    requirements: normalizeRequirements(request.requirements),
  });
}

function stringArrayOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function tokenCountOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function typedRequirementReasons(candidate, requirements) {
  const reasons = [];
  if (!requirements || Object.keys(requirements).length === 0) {
    return reasons;
  }

  const modalities = candidate.modalities ?? null;
  const candidateInput = modalities ? stringArrayOrNull(modalities.input) : null;
  const candidateOutput = modalities ? stringArrayOrNull(modalities.output) : null;
  for (const modality of requirements.inputModalities ?? []) {
    if (candidateInput === null || !candidateInput.includes(modality)) {
      reasons.push(`missing-modality:input:${modality}`);
    }
  }
  for (const modality of requirements.outputModalities ?? []) {
    if (candidateOutput === null || !candidateOutput.includes(modality)) {
      reasons.push(`missing-modality:output:${modality}`);
    }
  }

  const limits = candidate.limits ?? null;
  const contextWindow = limits ? tokenCountOrNull(limits.contextWindow) : null;
  if (requirements.minContextWindow !== null && requirements.minContextWindow !== undefined) {
    if (contextWindow === null) {
      reasons.push("missing-capability:contextWindow");
    } else if (contextWindow < requirements.minContextWindow) {
      reasons.push("insufficient-context-window");
    }
  }
  const maxOutputTokens = limits ? tokenCountOrNull(limits.maxOutputTokens) : null;
  if (requirements.maxOutputTokens !== null && requirements.maxOutputTokens !== undefined) {
    if (maxOutputTokens === null) {
      reasons.push("missing-capability:maxOutputTokens");
    } else if (maxOutputTokens < requirements.maxOutputTokens) {
      reasons.push("insufficient-max-output-tokens");
    }
  }

  for (const flag of ["toolCalling", "structuredOutput", "reasoning"]) {
    if (requirements[flag] === true) {
      const name = BOOLEAN_CAPABILITY_FOR_FLAG[flag];
      const value = candidate.capabilities[name];
      if (value === undefined || value === null) {
        reasons.push(`missing-capability:${name}`);
      } else if (value !== true) {
        reasons.push(`unsupported-capability:${name}`);
      }
    }
  }

  return reasons;
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
      .sort((left, right) => compareRouteIds(left.routeId, right.routeId))
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

        // TOG-4794: typed requirements, evaluated in fixed field order so the
        // dry-run explanation is deterministic. Missing or unknown candidate
        // data fails closed with an explicit reason — never treated as
        // supported. Candidates without modalities/limits data are only
        // excluded when a requirement actually constrains that dimension, so
        // legacy boolean-only requests are unaffected.
        reasons.push(...typedRequirementReasons(candidate, request.requirements));

        if (ELIGIBLE_STATES.has(candidate.supportState)) {
          reasons.push(...evidenceReasons(candidate, now, maxEvidenceAgeMs));
        }

        // Reasons are a distinct set of explanations in first-seen (fixed)
        // order: legacy boolean checks and typed flags can cover the same
        // capability (e.g. requiredCapabilities ["toolUse"] plus
        // requirements.toolCalling), and the dry-run output must not repeat it.
        const distinctReasons = [...new Set(reasons)];

        return Object.freeze({
          routeId: candidate.routeId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          supportState: candidate.supportState,
          eligible: distinctReasons.length === 0,
          reasons: Object.freeze(distinctReasons),
          rates: candidate.rates,
        });
      }),
  );
}
