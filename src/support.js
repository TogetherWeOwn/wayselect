export const SupportState = Object.freeze({
  CATALOGUED: "catalogued",
  CONFIGURED: "configured",
  CONFORMANCE_TESTED: "conformance-tested",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
});

const SUPPORT_STATES = new Set(Object.values(SupportState));
const CONFIGURATION_KEYS = new Set(["candidates"]);
const CANDIDATE_KEYS = new Set(["routeId", "supportState", "operations", "evidence"]);
const EVIDENCE_KEYS = new Set(["observedAt"]);

export class SupportConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SupportConfigurationError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new SupportConfigurationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SupportConfigurationError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertKnownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new SupportConfigurationError(`${label} contains unknown field: ${key}`);
    }
  }
}

function normalizeOperations(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new SupportConfigurationError(`${label} must be an array of non-empty strings`);
  }
  return Object.freeze([...new Set(value)].sort());
}

function normalizeEvidence(value, label) {
  if (value === undefined) {
    return null;
  }

  const evidence = requireObject(value, label);
  assertKnownKeys(evidence, EVIDENCE_KEYS, label);
  const observedAt = requireString(evidence.observedAt, `${label}.observedAt`);
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) {
    throw new SupportConfigurationError(`${label}.observedAt must be an ISO timestamp`);
  }

  return Object.freeze({ observedAt: new Date(timestamp).toISOString() });
}

export function applySupportConfiguration(catalog, configurationInput) {
  if (catalog === null || typeof catalog !== "object" || !Array.isArray(catalog.entries)) {
    throw new SupportConfigurationError("catalog.entries must be an array");
  }
  const configuration = requireObject(configurationInput, "configuration");
  assertKnownKeys(configuration, CONFIGURATION_KEYS, "configuration");
  if (!Array.isArray(configuration.candidates)) {
    throw new SupportConfigurationError("configuration.candidates must be an array");
  }

  const catalogByRoute = new Map();
  for (const [index, entry] of catalog.entries.entries()) {
    const label = `catalog.entries[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SupportConfigurationError(`${label} must be an object`);
    }
    if (typeof entry.routeId !== "string" || entry.routeId.trim() === "") {
      throw new SupportConfigurationError(
        `${label}.routeId must be a non-empty string`,
      );
    }
    if (catalogByRoute.has(entry.routeId)) {
      throw new SupportConfigurationError(
        `${label}.routeId is duplicated: ${entry.routeId}`,
      );
    }
    catalogByRoute.set(entry.routeId, entry);
  }
  const configuredByRoute = new Map();

  for (const [index, rawCandidate] of configuration.candidates.entries()) {
    const label = `configuration.candidates[${index}]`;
    const candidate = requireObject(rawCandidate, label);
    assertKnownKeys(candidate, CANDIDATE_KEYS, label);

    const routeId = requireString(candidate.routeId, `${label}.routeId`);
    if (!catalogByRoute.has(routeId)) {
      throw new SupportConfigurationError(`${label}.routeId is not present in the catalog: ${routeId}`);
    }
    if (configuredByRoute.has(routeId)) {
      throw new SupportConfigurationError(`${label}.routeId is duplicated: ${routeId}`);
    }

    const supportState = requireString(candidate.supportState, `${label}.supportState`);
    if (!SUPPORT_STATES.has(supportState)) {
      throw new SupportConfigurationError(`${label}.supportState is unknown: ${supportState}`);
    }

    const operations = normalizeOperations(
      candidate.operations === undefined ? [] : candidate.operations,
      `${label}.operations`,
    );
    const evidence = normalizeEvidence(candidate.evidence, `${label}.evidence`);
    if (
      (supportState === SupportState.CONFIGURED ||
        supportState === SupportState.CONFORMANCE_TESTED) &&
      operations.length === 0
    ) {
      throw new SupportConfigurationError(`${label}.operations must not be empty for ${supportState}`);
    }

    configuredByRoute.set(routeId, { supportState, operations, evidence });
  }

  return Object.freeze(
    catalog.entries.map((entry) => {
      const configured = configuredByRoute.get(entry.routeId);
      if (!configured) {
        return Object.freeze({
          ...entry,
          configuredOperations: Object.freeze([]),
          evidence: null,
        });
      }

      return Object.freeze({
        ...entry,
        supportState: configured.supportState,
        configuredOperations: configured.operations,
        evidence: configured.evidence,
      });
    }),
  );
}
