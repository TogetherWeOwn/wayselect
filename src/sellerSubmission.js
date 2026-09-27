// Seller-submission intake validator for the Wayselect seller-onboarding
// slice (TOG-5118 test leaf for the TOG-4969 build; spec: TOG-4958 §2).
//
// Pure, fixture-only, no backend: a seller submission in, a frozen normalized
// submission out. Anything malformed is rejected fail-closed with a typed
// SellerSubmissionError carrying a stable `code`, the offending `key` path,
// and the provenance `source` (SD8: every rejection names the offending key +
// provenance source before anything renders).
//
// Accepted envelope (exact keys, `additionalProperties: false` at every level):
//   providerId  — seller identity (non-empty string; entry.family is never this)
//   modelId     — listing id; must equal entry.id (SG2 interim convention)
//   entry       — v1 listing fields per spec §2
//   provenance  — { source, fetchedAt } + optional etag; required, always
//
// Executable location fields (url, endpoint, baseUrl, apiUrl) are never
// accepted anywhere in a submission (SG6).

const SUBMISSION_KEYS = new Set(["providerId", "modelId", "entry", "provenance"]);
const ENTRY_KEYS = new Set([
  "id",
  "name",
  "description",
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
  "temperature",
  "modalities",
  "limit",
  "cost",
  "release_date",
  "last_updated",
  "open_weights",
  "status",
]);
const MODALITY_KEYS = new Set(["input", "output"]);
const MODALITY_ENUM = new Set(["text", "image", "audio", "video", "pdf"]);
const LIMIT_KEYS = new Set(["context", "output", "input"]);
const COST_KEYS = new Set(["input", "output"]);
const PROVENANCE_KEYS = new Set(["source", "fetchedAt", "etag"]);
const STATUS_ENUM = new Set(["deprecated", "beta"]);
const FORBIDDEN_LOCATION_KEYS = new Set(["url", "endpoint", "baseUrl", "apiUrl"]);

export class SellerSubmissionError extends Error {
  constructor(message, { code, key = null, source = null } = {}) {
    super(message);
    this.name = "SellerSubmissionError";
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
  throw new SellerSubmissionError(`[${sourceTag(source)}] ${detail}`, { code, key, source });
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

function requireBoolean(value, label, key, source) {
  if (typeof value !== "boolean") {
    fail("invalid-type", key, source, `${label} must be a boolean`);
  }
  return value;
}

function optionalBoolean(value, label, key, source) {
  if (value === undefined) {
    return null;
  }
  return requireBoolean(value, label, key, source);
}

function assertKnownKeys(value, allowedKeys, label, key, source) {
  for (const field of Object.keys(value)) {
    if (!allowedKeys.has(field)) {
      fail("unknown-field", `${key}.${field}`, source, `${label} contains unknown field: ${field}`);
    }
  }
}

function assertNoLocationFields(value, path, source) {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [field, nested] of Object.entries(value)) {
    if (FORBIDDEN_LOCATION_KEYS.has(field)) {
      const key = `${path}.${field}`;
      fail(
        "forbidden-field",
        key,
        source,
        `submission must not contain executable location field: ${key}`,
      );
    }
    assertNoLocationFields(nested, `${path}.${field}`, source);
  }
}

function extractSource(submission) {
  const provenance = submission !== null && typeof submission === "object" ? submission.provenance : null;
  if (isPlainObject(provenance) && typeof provenance.source === "string" && provenance.source !== "") {
    return provenance.source;
  }
  return null;
}

function normalizeModalityList(value, label, key, source) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("missing-field", key, source, `${label} must be a non-empty array`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !MODALITY_ENUM.has(item)) {
      fail(
        "invalid-value",
        key,
        source,
        `${label} must only contain ${[...MODALITY_ENUM].sort().join(", ")}`,
      );
    }
  }
  return Object.freeze([...new Set(value)].sort());
}

function normalizeModalities(value, key, source) {
  const modalities = requireObject(value, "entry.modalities", key, source);
  assertKnownKeys(modalities, MODALITY_KEYS, "entry.modalities", key, source);
  if (modalities.input === undefined || modalities.output === undefined) {
    fail("missing-field", key, source, "entry.modalities requires input and output");
  }
  return Object.freeze({
    input: normalizeModalityList(modalities.input, "entry.modalities.input", `${key}.input`, source),
    output: normalizeModalityList(
      modalities.output,
      "entry.modalities.output",
      `${key}.output`,
      source,
    ),
  });
}

function normalizeLimitInteger(value, label, key, source) {
  if (!Number.isInteger(value) || value < 0) {
    fail("invalid-value", key, source, `${label} must be an integer >= 0`);
  }
  return value;
}

function normalizeLimit(value, key, source) {
  const limit = requireObject(value, "entry.limit", key, source);
  assertKnownKeys(limit, LIMIT_KEYS, "entry.limit", key, source);
  if (limit.context === undefined || limit.output === undefined) {
    fail("missing-field", key, source, "entry.limit requires context and output");
  }
  return Object.freeze({
    context: normalizeLimitInteger(limit.context, "entry.limit.context", `${key}.context`, source),
    output: normalizeLimitInteger(limit.output, "entry.limit.output", `${key}.output`, source),
    input:
      limit.input === undefined
        ? null
        : normalizeLimitInteger(limit.input, "entry.limit.input", `${key}.input`, source),
  });
}

function normalizeCost(value, key, source) {
  if (value === undefined) {
    return null;
  }
  const cost = requireObject(value, "entry.cost", key, source);
  assertKnownKeys(cost, COST_KEYS, "entry.cost", key, source);
  if (cost.input === undefined || cost.output === undefined) {
    fail("missing-field", key, source, "entry.cost requires input and output when present");
  }
  for (const field of ["input", "output"]) {
    if (!Number.isFinite(cost[field]) || cost[field] < 0) {
      fail(
        "invalid-value",
        `${key}.${field}`,
        source,
        `entry.cost.${field} must be a non-negative number as-published`,
      );
    }
  }
  return Object.freeze({ input: cost.input, output: cost.output });
}

function normalizeReleaseDate(value, label, key, source) {
  requireNonEmptyString(value, label, key, source);
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(value);
  if (!match) {
    fail("invalid-value", key, source, `${label} must use YYYY-MM or YYYY-MM-DD`);
  }
  if (match[3] !== undefined) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const roundTrip = new Date(Date.UTC(year, month - 1, day));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month - 1 ||
      roundTrip.getUTCDate() !== day
    ) {
      fail("invalid-value", key, source, `${label} must be a real calendar date`);
    }
  }
  return value;
}

function normalizeEntry(value, source) {
  const entry = requireObject(value, "entry", "entry", source);
  assertKnownKeys(entry, ENTRY_KEYS, "entry", "entry", source);

  for (const field of [
    "id",
    "name",
    "description",
    "attachment",
    "reasoning",
    "tool_call",
    "modalities",
    "limit",
    "release_date",
    "last_updated",
    "open_weights",
  ]) {
    if (entry[field] === undefined) {
      fail("missing-field", `entry.${field}`, source, `entry.${field} is required`);
    }
  }

  const status =
    entry.status === undefined
      ? null
      : STATUS_ENUM.has(entry.status)
        ? entry.status
        : fail(
            "invalid-value",
            "entry.status",
            source,
            "entry.status must be deprecated or beta when present",
          );

  return Object.freeze({
    id: requireNonEmptyString(entry.id, "entry.id", "entry.id", source),
    name: requireNonEmptyString(entry.name, "entry.name", "entry.name", source),
    description: requireNonEmptyString(
      entry.description,
      "entry.description",
      "entry.description",
      source,
    ),
    attachment: requireBoolean(entry.attachment, "entry.attachment", "entry.attachment", source),
    reasoning: requireBoolean(entry.reasoning, "entry.reasoning", "entry.reasoning", source),
    tool_call: requireBoolean(entry.tool_call, "entry.tool_call", "entry.tool_call", source),
    structured_output: optionalBoolean(
      entry.structured_output,
      "entry.structured_output",
      "entry.structured_output",
      source,
    ),
    temperature: optionalBoolean(entry.temperature, "entry.temperature", "entry.temperature", source),
    modalities: normalizeModalities(entry.modalities, "entry.modalities", source),
    limit: normalizeLimit(entry.limit, "entry.limit", source),
    cost: normalizeCost(entry.cost, "entry.cost", source),
    release_date: normalizeReleaseDate(
      entry.release_date,
      "entry.release_date",
      "entry.release_date",
      source,
    ),
    last_updated: normalizeReleaseDate(
      entry.last_updated,
      "entry.last_updated",
      "entry.last_updated",
      source,
    ),
    open_weights: requireBoolean(entry.open_weights, "entry.open_weights", "entry.open_weights", source),
    status,
  });
}

function normalizeProvenance(value) {
  const provenance = requireObject(value, "provenance", "provenance", null);
  const rawSource =
    typeof provenance.source === "string" && provenance.source !== ""
      ? provenance.source
      : null;
  // Forbidden location fields are reported as forbidden even inside
  // provenance (this runs before the whole-submission scan in the caller).
  assertNoLocationFields(provenance, "provenance", rawSource);
  assertKnownKeys(provenance, PROVENANCE_KEYS, "provenance", "provenance", rawSource);

  const source = requireNonEmptyString(
    provenance.source,
    "provenance.source",
    "provenance.source",
    null,
  );
  const fetchedAt = requireNonEmptyString(
    provenance.fetchedAt,
    "provenance.fetchedAt",
    "provenance.fetchedAt",
    source,
  );
  if (!Number.isFinite(Date.parse(fetchedAt))) {
    fail(
      "invalid-value",
      "provenance.fetchedAt",
      source,
      "provenance.fetchedAt must be an ISO timestamp",
    );
  }
  const etag =
    provenance.etag === undefined
      ? null
      : requireNonEmptyString(provenance.etag, "provenance.etag", "provenance.etag", source);

  return Object.freeze({ source, fetchedAt: new Date(Date.parse(fetchedAt)).toISOString(), etag });
}

export function validateSellerSubmission(submission) {
  const source = extractSource(submission);
  const input = requireObject(submission, "submission", "submission", source);

  if (input.provenance === undefined) {
    fail("missing-provenance", "provenance", source, "submission.provenance is required");
  }
  const provenance = normalizeProvenance(input.provenance);
  const provenanceSource = provenance.source;

  // Executable location fields are never accepted, at any depth (SG6).
  // Scanned before unknown-field checks so a forbidden field is always
  // reported as forbidden, even where it is also unknown.
  assertNoLocationFields(input, "submission", provenanceSource);
  assertKnownKeys(input, SUBMISSION_KEYS, "submission", "submission", provenanceSource);

  const providerId = requireNonEmptyString(
    input.providerId,
    "providerId",
    "providerId",
    provenanceSource,
  );
  const modelId = requireNonEmptyString(input.modelId, "modelId", "modelId", provenanceSource);
  if (input.entry === undefined) {
    fail("missing-field", "entry", provenanceSource, "submission.entry is required");
  }
  const entry = normalizeEntry(input.entry, provenanceSource);

  // SG2 interim convention: modelId and entry.id are submitted equal.
  if (modelId !== entry.id) {
    fail(
      "id-mismatch",
      "modelId",
      provenanceSource,
      `modelId (${modelId}) must equal entry.id (${entry.id})`,
    );
  }

  return Object.freeze({
    routeId: `${providerId}/${modelId}`,
    providerId,
    modelId,
    entry,
    provenance,
  });
}
