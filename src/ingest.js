// Ingestion adapter: models.dev-shaped JSON → normalized catalog input.
//
// Maps provider-keyed models.dev data (providers → models with modalities,
// limits, tool/structured-output flags and list prices) onto the existing
// normalized catalog schema (see src/catalog.js), attaching provenance
// (source URL, snapshot timestamp, sha256).
//
// Every ingested entry lands as support state `catalogued` only — ingestion
// never configures, enables, or produces executable URLs. Unknown or
// malformed fields are quarantined with reasons, never guessed as
// capabilities. Known models.dev extras (pricing/URL/documentation metadata)
// are stripped at the boundary; the URL-bearing ones (`api`, `endpoint`,
// `doc`) are stripped so ingestion cannot emit executable locations.
//
// Provenance hashes are pinned through main's `computeCatalogSnapshotHash`
// gate: the default snapshot hash IS the canonical body hash, so ingested
// output always passes `normalizeCatalog` verification; an explicitly passed
// hash that does not match the ingested body fails closed instead of
// producing an unverifiable document.
//
// Probe data stays out of the repo: tests use small newly-authored
// models.dev-shaped fixtures (test/ingest.test.js), never a redistributed
// snapshot.

import { createHash } from "node:crypto";
import {
  computeCatalogSnapshotHash,
  normalizeCatalog,
  stableStringify,
} from "./catalog.js";

export const DEFAULT_MODELS_DEV_SOURCE = "https://models.dev/api.json";

export class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = "IngestError";
  }
}

// Model keys mapped into the normalized catalog schema. `limit` is mapped
// (`context` → `context_window`, `output` → `max_output_tokens`); the rest
// pass through under their catalog names.
const MAPPED_MODEL_KEYS = new Set([
  "id",
  "name",
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
  "modalities",
  "cost",
  "limit",
]);

// Known models.dev extras: stripped at the boundary, never guessed as
// capabilities and never passed through. Temperature/knowledge/release-date/
// open-weights describe the upstream model card, not catalogued behavior; the
// URL-bearing fields are stripped so no executable location can leak into the
// catalog. Anything else unknown quarantines the entry instead.
const STRIPPED_MODEL_KEYS = new Set([
  "api",
  "doc",
  "endpoint",
  "knowledge",
  "open_weights",
  "release_date",
  "temperature",
]);

const MAPPED_PROVIDER_KEYS = new Set(["id", "name", "models"]);
const STRIPPED_PROVIDER_KEYS = new Set(["api", "doc", "endpoint"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Stable content hash of a JSON-shaped value: object key order does not
// affect the digest, array order does. Uses main's canonical form so the
// adapter hash and the provenance hash byte-match.
export function hashSnapshot(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function hashRawText(text) {
  if (typeof text !== "string") {
    throw new IngestError("hashRawText expects a string");
  }
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function freezeQuarantine(routeId, reason) {
  return Object.freeze({ routeId, reason });
}

function resolveProvenance(options, catalog) {
  const opts = options ?? {};
  if (
    opts.source === undefined ||
    typeof opts.source !== "string" ||
    opts.source.trim() === ""
  ) {
    throw new IngestError("options.source must be a non-empty string");
  }

  let snapshotTimestamp = opts.snapshotTimestamp;
  if (snapshotTimestamp === undefined) {
    snapshotTimestamp = new Date().toISOString();
  } else if (
    typeof snapshotTimestamp !== "string" ||
    !Number.isFinite(Date.parse(snapshotTimestamp))
  ) {
    throw new IngestError("options.snapshotTimestamp must be an ISO timestamp");
  } else {
    snapshotTimestamp = new Date(Date.parse(snapshotTimestamp)).toISOString();
  }

  // Default hash is the canonical body hash, so a default provenance
  // round-trips through normalizeCatalog's snapshot-hash gate and identifies
  // exactly what was ingested.
  const actualHash = computeCatalogSnapshotHash(catalog);
  let snapshotHash = opts.snapshotHash;
  if (snapshotHash === undefined) {
    snapshotHash = actualHash;
  } else if (
    typeof snapshotHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(snapshotHash)
  ) {
    throw new IngestError(
      "options.snapshotHash must use the form sha256:<64 lowercase hex characters>",
    );
  } else if (snapshotHash !== actualHash) {
    throw new IngestError(
      `options.snapshotHash does not match the ingested catalog body ` +
        `(claimed ${snapshotHash}, computed ${actualHash}); refusing tampered or stale feed`,
    );
  }

  return Object.freeze({
    source: opts.source,
    snapshotTimestamp,
    snapshotHash,
  });
}

function trialTimestamp(options) {
  const raw = options?.snapshotTimestamp;
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) {
    return new Date(Date.parse(raw)).toISOString();
  }
  return new Date().toISOString();
}

function trialSource(options) {
  return typeof options?.source === "string" && options.source !== ""
    ? options.source
    : "ingest-trial";
}

// Map one models.dev model onto catalog input fields. Unknown fields are
// deliberately passed through so the trial normalization below rejects them
// with a named reason; known extras were stripped by the caller.
function mapModelFields(source) {
  const mapped = {};
  for (const key of [
    "id",
    "name",
    "attachment",
    "reasoning",
    "tool_call",
    "structured_output",
    "modalities",
  ]) {
    if (source[key] !== undefined) {
      mapped[key] = structuredClone(source[key]);
    }
  }

  // List prices only: sibling pricing metadata (e.g. cache_read) is stripped.
  if (source.cost !== undefined) {
    if (isPlainObject(source.cost)) {
      const cost = {};
      if (source.cost.input !== undefined) {
        cost.input = source.cost.input;
      }
      if (source.cost.output !== undefined) {
        cost.output = source.cost.output;
      }
      mapped.cost = cost;
    } else {
      mapped.cost = source.cost;
    }
  }

  // models.dev `limit: {context, output}` maps onto the normalized catalog
  // fields `context_window` / `max_output_tokens`. Each present side maps;
  // absent sides stay absent (normalization records them as null).
  if (source.limit !== undefined) {
    if (!isPlainObject(source.limit)) {
      return {
        error: "limit must be an object with optional context/output when present",
      };
    }
    // Unknown limit subfields quarantine: an upstream schema addition inside
    // `limit` (e.g. a new bound) must surface for review, never be silently
    // discarded. Mirrors the top-level unknown-field contract.
    for (const key of Object.keys(source.limit).sort()) {
      if (key !== "context" && key !== "output") {
        return {
          error: `limit contains unknown field: ${key}`,
        };
      }
    }
    if (source.limit.context !== undefined) {
      mapped.context_window = source.limit.context;
    }
    if (source.limit.output !== undefined) {
      mapped.max_output_tokens = source.limit.output;
    }
  }

  for (const key of Object.keys(source).sort()) {
    if (!MAPPED_MODEL_KEYS.has(key) && !STRIPPED_MODEL_KEYS.has(key)) {
      mapped[key] = structuredClone(source[key]);
    }
  }
  return { mapped };
}

// Trial-normalize a single mapped model so every kept entry is guaranteed to
// normalize cleanly; failures quarantine with the validation reason. The
// trial provenance carries the per-model canonical body hash so the
// snapshot-hash gate verifies exactly what is being trialled.
function ingestModel(providerKey, modelKey, source, providerName, options) {
  if (!isPlainObject(source)) {
    return {
      quarantined: freezeQuarantine(
        `${providerKey}/${modelKey}`,
        `provider ${providerKey} model ${modelKey} must be an object`,
      ),
    };
  }
  const { mapped, error } = mapModelFields(source);
  if (error !== undefined) {
    return {
      quarantined: freezeQuarantine(`${providerKey}/${modelKey}`, error),
    };
  }
  const trialCatalog = {
    [providerKey]: {
      id: providerKey,
      name: providerName,
      models: { [modelKey]: mapped },
    },
  };
  const trialProvenance = {
    source: trialSource(options),
    snapshotTimestamp: trialTimestamp(options),
    snapshotHash: computeCatalogSnapshotHash(trialCatalog),
  };
  try {
    normalizeCatalog(trialCatalog, trialProvenance);
  } catch (validationError) {
    return {
      quarantined: freezeQuarantine(
        `${providerKey}/${modelKey}`,
        validationError instanceof Error
          ? validationError.message
          : String(validationError),
      ),
    };
  }
  return { mapped: Object.freeze(mapped) };
}

function ingestProvider(providerKey, source, options, quarantined) {
  if (!isPlainObject(source)) {
    quarantined.push(
      freezeQuarantine(providerKey, `provider ${providerKey} must be an object`),
    );
    return null;
  }
  if (source.id !== providerKey) {
    quarantined.push(
      freezeQuarantine(
        providerKey,
        `provider ${providerKey}.id must match its catalog key`,
      ),
    );
    return null;
  }
  for (const key of Object.keys(source).sort()) {
    if (!MAPPED_PROVIDER_KEYS.has(key) && !STRIPPED_PROVIDER_KEYS.has(key)) {
      quarantined.push(
        freezeQuarantine(providerKey, `provider ${providerKey}: unknown field: ${key}`),
      );
      return null;
    }
  }
  if (!isPlainObject(source.models)) {
    quarantined.push(
      freezeQuarantine(providerKey, `provider ${providerKey}.models must be an object`),
    );
    return null;
  }

  const models = {};
  for (const modelKey of Object.keys(source.models).sort()) {
    const { mapped, quarantined: rejected } = ingestModel(
      providerKey,
      modelKey,
      source.models[modelKey],
      source.name,
      options,
    );
    if (rejected !== undefined) {
      quarantined.push(rejected);
    } else {
      models[modelKey] = mapped;
    }
  }
  // Providers with no surviving models contribute no entries; their models'
  // quarantine reasons already account for the rejection.
  if (Object.keys(models).length === 0) {
    return null;
  }
  return Object.freeze({ id: providerKey, name: source.name, models });
}

export function ingestModelsDev(input, options) {
  if (!isPlainObject(input)) {
    throw new IngestError("models.dev input must be an object keyed by provider id");
  }
  const providerKeys = Object.keys(input).sort();
  if (providerKeys.length === 0) {
    throw new IngestError("models.dev input must contain at least one provider");
  }

  const quarantined = [];
  const catalog = {};
  for (const providerKey of providerKeys) {
    const provider = ingestProvider(
      providerKey,
      input[providerKey],
      options,
      quarantined,
    );
    if (provider !== null) {
      catalog[providerKey] = provider;
    }
  }

  const provenance = resolveProvenance(options, catalog);

  // Final sanity: everything kept must normalize as catalogued-only. This
  // cannot fail after per-model trials plus the hash match above, so a throw
  // here is an adapter bug, not input.
  try {
    normalizeCatalog(catalog, provenance);
  } catch (validationError) {
    throw new IngestError(
      `ingested catalog failed validation: ${validationError.message}`,
    );
  }

  return Object.freeze({
    catalog: Object.freeze(catalog),
    provenance,
    quarantined: Object.freeze(quarantined),
  });
}
