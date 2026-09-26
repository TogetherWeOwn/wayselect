const PROVIDER_KEYS = new Set(["id", "name", "models"]);
const MODEL_KEYS = new Set([
  "id",
  "name",
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
  "modalities",
  "cost",
]);
const MODALITY_KEYS = new Set(["input", "output"]);
const COST_KEYS = new Set(["input", "output"]);

export class CatalogValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new CatalogValidationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CatalogValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new CatalogValidationError(`${label} must be a boolean when present`);
  }
  return value;
}

function assertKnownKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new CatalogValidationError(`${label} contains unknown field: ${key}`);
    }
  }
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new CatalogValidationError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)].sort();
}

function normalizeModalities(value, label) {
  const modalities = requireObject(value, label);
  assertKnownKeys(modalities, MODALITY_KEYS, label);

  return {
    input: normalizeStringArray(modalities.input, `${label}.input`),
    output: normalizeStringArray(modalities.output, `${label}.output`),
  };
}

function normalizeCost(value, label) {
  if (value === undefined) {
    return null;
  }

  const cost = requireObject(value, label);
  assertKnownKeys(cost, COST_KEYS, label);
  const input = cost.input;
  const output = cost.output;

  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
    throw new CatalogValidationError(`${label} input and output must be non-negative numbers`);
  }

  return Object.freeze({
    inputPerMillion: input,
    outputPerMillion: output,
    label: "synthetic/list-price estimate only",
  });
}

function normalizeProvenance(value) {
  const provenance = requireObject(value, "provenance");
  assertKnownKeys(provenance, new Set(["source", "snapshotTimestamp", "snapshotHash"]), "provenance");

  const source = requireString(provenance.source, "provenance.source");
  const snapshotTimestamp = requireString(
    provenance.snapshotTimestamp,
    "provenance.snapshotTimestamp",
  );
  const timestamp = Date.parse(snapshotTimestamp);
  if (!Number.isFinite(timestamp)) {
    throw new CatalogValidationError("provenance.snapshotTimestamp must be an ISO timestamp");
  }

  const snapshotHash = requireString(provenance.snapshotHash, "provenance.snapshotHash");
  if (!/^sha256:[a-f0-9]{64}$/.test(snapshotHash)) {
    throw new CatalogValidationError(
      "provenance.snapshotHash must use the form sha256:<64 lowercase hex characters>",
    );
  }

  return Object.freeze({
    source,
    snapshotTimestamp: new Date(timestamp).toISOString(),
    snapshotHash,
  });
}

function normalizeModel(providerId, modelKey, value) {
  const label = `provider ${providerId} model ${modelKey}`;
  const model = requireObject(value, label);
  assertKnownKeys(model, MODEL_KEYS, label);

  const modelId = requireString(model.id, `${label}.id`);
  if (modelId !== modelKey) {
    throw new CatalogValidationError(`${label}.id must match its catalog key`);
  }

  const modalities = normalizeModalities(model.modalities, `${label}.modalities`);
  const capabilityValues = {
    attachment: optionalBoolean(model.attachment, `${label}.attachment`),
    reasoning: optionalBoolean(model.reasoning, `${label}.reasoning`),
    toolUse: optionalBoolean(model.tool_call, `${label}.tool_call`),
    structuredOutput: optionalBoolean(model.structured_output, `${label}.structured_output`),
    imageInput: modalities.input.includes("image"),
    textInput: modalities.input.includes("text"),
    textOutput: modalities.output.includes("text"),
  };

  const catalogOperations = [];
  if (capabilityValues.textInput && capabilityValues.textOutput) {
    catalogOperations.push("chat");
  }
  if (capabilityValues.imageInput && capabilityValues.textOutput) {
    catalogOperations.push("vision-chat");
  }

  return Object.freeze({
    routeId: `${providerId}/${modelId}`,
    providerId,
    modelId,
    name: requireString(model.name, `${label}.name`),
    supportState: "catalogued",
    catalogOperations: Object.freeze(catalogOperations.sort()),
    capabilities: Object.freeze(capabilityValues),
    rates: normalizeCost(model.cost, `${label}.cost`),
  });
}

export function normalizeCatalog(input, provenanceInput) {
  const providers = requireObject(input, "catalog");
  const provenance = normalizeProvenance(provenanceInput);
  const entries = [];

  for (const providerKey of Object.keys(providers).sort()) {
    const label = `provider ${providerKey}`;
    const provider = requireObject(providers[providerKey], label);
    assertKnownKeys(provider, PROVIDER_KEYS, label);

    const providerId = requireString(provider.id, `${label}.id`);
    if (providerId !== providerKey) {
      throw new CatalogValidationError(`${label}.id must match its catalog key`);
    }
    requireString(provider.name, `${label}.name`);

    const models = requireObject(provider.models, `${label}.models`);
    for (const modelKey of Object.keys(models).sort()) {
      entries.push(normalizeModel(providerId, modelKey, models[modelKey]));
    }
  }

  return Object.freeze({
    provenance,
    entries: Object.freeze(entries),
  });
}
