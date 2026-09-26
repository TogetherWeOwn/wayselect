import { SupportState } from "./support.js";

const ELIGIBLE_STATES = new Set([
  SupportState.CONFIGURED,
  SupportState.CONFORMANCE_TESTED,
]);

export const EligibilityCheck = Object.freeze({
  SUPPORT_STATE: "support-state",
  PROVIDER_ALLOWLIST: "provider-allowlist",
  OPERATION_CATALOGUED: "operation-catalogued",
  OPERATION_CONFIGURED: "operation-configured",
  CAPABILITY: "capability",
  EVIDENCE_FRESHNESS: "evidence-freshness",
});

export const CheckStatus = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  SKIPPED: "skipped",
});

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

  return { now, maxEvidenceAgeMs };
}

export function normalizeSelectionRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new EligibilityRequestError("request must be an object");
  }

  return Object.freeze({
    operation: nonEmptyString(request.operation, "request.operation"),
    requiredCapabilities: Object.freeze(
      uniqueStringArray(request.requiredCapabilities ?? [], "request.requiredCapabilities"),
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

  const observedAt = Date.parse(candidate.evidence.observedAt);
  const ageMs = now.getTime() - observedAt;
  if (ageMs < 0) {
    return ["future-evidence"];
  }
  if (ageMs > maxEvidenceAgeMs) {
    return ["stale-evidence"];
  }
  return [];
}

export function buildEligibilityTrace(candidates, requestInput, optionsInput) {
  const request = normalizeSelectionRequest(requestInput);
  const { now, maxEvidenceAgeMs } = normalizeOptions(optionsInput);
  const allowedProviders = new Set(request.providerAllowlist);

  return Object.freeze(
    [...candidates]
      .sort((left, right) => left.routeId.localeCompare(right.routeId))
      .map((candidate) => {
        const checks = [];
        const recordPass = (check) => {
          checks.push(Object.freeze({ check, status: CheckStatus.PASS, reason: null }));
        };
        const recordFail = (check, reason) => {
          checks.push(Object.freeze({ check, status: CheckStatus.FAIL, reason }));
        };

        const supportEligible = ELIGIBLE_STATES.has(candidate.supportState);
        if (supportEligible) {
          recordPass(EligibilityCheck.SUPPORT_STATE);
        } else {
          recordFail(EligibilityCheck.SUPPORT_STATE, `support-state:${candidate.supportState}`);
        }

        if (allowedProviders.has(candidate.providerId)) {
          recordPass(EligibilityCheck.PROVIDER_ALLOWLIST);
        } else {
          recordFail(EligibilityCheck.PROVIDER_ALLOWLIST, "provider-not-allowed");
        }

        if (candidate.catalogOperations.includes(request.operation)) {
          recordPass(EligibilityCheck.OPERATION_CATALOGUED);
        } else {
          recordFail(EligibilityCheck.OPERATION_CATALOGUED, "operation-not-catalogued");
        }

        if (candidate.configuredOperations.includes(request.operation)) {
          recordPass(EligibilityCheck.OPERATION_CONFIGURED);
        } else {
          recordFail(EligibilityCheck.OPERATION_CONFIGURED, "operation-not-configured");
        }

        for (const capability of request.requiredCapabilities) {
          const check = `${EligibilityCheck.CAPABILITY}:${capability}`;
          const value = candidate.capabilities[capability];
          if (value === undefined || value === null) {
            recordFail(check, `missing-capability:${capability}`);
          } else if (value !== true) {
            recordFail(check, `unsupported-capability:${capability}`);
          } else {
            recordPass(check);
          }
        }

        if (supportEligible) {
          const freshnessFailures = evidenceReasons(candidate, now, maxEvidenceAgeMs);
          if (freshnessFailures.length === 0) {
            recordPass(EligibilityCheck.EVIDENCE_FRESHNESS);
          } else {
            for (const reason of freshnessFailures) {
              recordFail(EligibilityCheck.EVIDENCE_FRESHNESS, reason);
            }
          }
        } else {
          checks.push(
            Object.freeze({
              check: EligibilityCheck.EVIDENCE_FRESHNESS,
              status: CheckStatus.SKIPPED,
              reason: "evidence-not-evaluated",
            }),
          );
        }

        const reasons = Object.freeze(
          checks
            .filter((entry) => entry.status === CheckStatus.FAIL)
            .map((entry) => entry.reason),
        );
        const eligible = reasons.length === 0;

        return Object.freeze({
          routeId: candidate.routeId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          supportState: candidate.supportState,
          eligible,
          verdict: eligible ? "eligible" : "excluded",
          reasons,
          checks: Object.freeze(checks),
          rates: candidate.rates,
        });
      }),
  );
}

export function evaluateEligibility(candidates, requestInput, optionsInput) {
  return Object.freeze(
    buildEligibilityTrace(candidates, requestInput, optionsInput).map((entry) =>
      Object.freeze({
        routeId: entry.routeId,
        providerId: entry.providerId,
        modelId: entry.modelId,
        supportState: entry.supportState,
        eligible: entry.eligible,
        reasons: entry.reasons,
        rates: entry.rates,
      }),
    ),
  );
}
