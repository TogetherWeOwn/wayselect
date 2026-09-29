import { createHash } from "node:crypto";
import { computeCatalogSnapshotHash, normalizeCatalog } from "./catalog.js";
import { CatalogFreshnessError, checkCatalogFreshness } from "./freshness.js";

export const DEFAULT_STAGING_SOURCE_PREFIX = "synthetic://";

export const KNOWN_CAPABILITY_NAMES = Object.freeze([
  "attachment",
  "reasoning",
  "toolUse",
  "structuredOutput",
]);

export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotError";
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function requireSnapshotEntry(entry, label) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SnapshotError(`${label} must be a snapshot entry object`);
  }
  if (typeof entry.routeId !== "string" || entry.routeId === "") {
    throw new SnapshotError(`${label}.routeId must be a non-empty string`);
  }
  if (
    !Array.isArray(entry.catalogOperations) ||
    entry.catalogOperations.some((item) => typeof item !== "string" || item === "")
  ) {
    throw new SnapshotError(
      `${label}.catalogOperations must be an array of non-empty strings`,
    );
  }
  if (
    entry.capabilities === null ||
    typeof entry.capabilities !== "object" ||
    Array.isArray(entry.capabilities)
  ) {
    throw new SnapshotError(`${label}.capabilities must be an object`);
  }
  if (entry.rates !== null && entry.rates !== undefined) {
    if (typeof entry.rates !== "object" || Array.isArray(entry.rates)) {
      throw new SnapshotError(`${label}.rates must be an object when present`);
    }
  }
  return entry;
}

function canonicalEntry(entry) {
  return {
    routeId: entry.routeId,
    providerId: entry.providerId,
    modelId: entry.modelId,
    name: entry.name,
    catalogOperations: [...entry.catalogOperations],
    capabilities: { ...entry.capabilities },
    rates: entry.rates
      ? {
          inputPerMillion: entry.rates.inputPerMillion,
          outputPerMillion: entry.rates.outputPerMillion,
        }
      : null,
  };
}

function compareRouteId(left, right) {
  if (left.routeId < right.routeId) {
    return -1;
  }
  if (left.routeId > right.routeId) {
    return 1;
  }
  return 0;
}

export function computeContentHash(entries) {
  if (!Array.isArray(entries)) {
    throw new SnapshotError("entries must be an array");
  }
  entries.forEach((entry, index) => requireSnapshotEntry(entry, `entries[${index}]`));
  const canonical = [...entries].map(canonicalEntry).sort(compareRouteId);
  return `sha256:${createHash("sha256").update(stableStringify(canonical)).digest("hex")}`;
}

export function findEntryGaps(entry) {
  requireSnapshotEntry(entry, "entry");
  const gaps = [];
  for (const name of KNOWN_CAPABILITY_NAMES) {
    if (entry.capabilities[name] === null || entry.capabilities[name] === undefined) {
      gaps.push(
        Object.freeze({ routeId: entry.routeId, gap: `missing-capability:${name}` }),
      );
    }
  }
  if (!entry.rates) {
    gaps.push(Object.freeze({ routeId: entry.routeId, gap: "missing-rates" }));
  }
  if (entry.catalogOperations.length === 0) {
    gaps.push(Object.freeze({ routeId: entry.routeId, gap: "no-catalogued-operations" }));
  }
  return Object.freeze(gaps);
}

function normalizeCollectedAt(value) {
  const collectedAt = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(collectedAt.getTime())) {
    throw new SnapshotError("options.now must be a valid date");
  }
  return collectedAt.toISOString();
}

export function buildSnapshot(catalogInput, provenanceInput, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SnapshotError("options must be an object when present");
  }
  if (options.sourcePrefix !== undefined) {
    if (typeof options.sourcePrefix !== "string" || options.sourcePrefix === "") {
      throw new SnapshotError("options.sourcePrefix must be a non-empty string when present");
    }
  }
  const sourcePrefix = options.sourcePrefix ?? DEFAULT_STAGING_SOURCE_PREFIX;
  const declaredSource = provenanceInput?.source;
  if (typeof declaredSource !== "string" || !declaredSource.startsWith(sourcePrefix)) {
    throw new SnapshotError(
      `refusing non-staging catalog source: ${JSON.stringify(declaredSource)} ` +
        `(staging-only snapshot; expected source prefix ${JSON.stringify(sourcePrefix)})`,
    );
  }

  // TOG-5725: validate the snapshot clock up front so an invalid --now
  // keeps its legacy CatalogFreshnessError (exact-bytes CLI contract) instead
  // of surfacing from the fetchedAt default first, then forward it so a
  // pinned --now yields byte-identical output instead of a wall-clock stamp.
  if (options.now !== undefined) {
    const parsed = options.now instanceof Date ? options.now : new Date(options.now);
    if (!Number.isFinite(parsed.getTime())) {
      throw new CatalogFreshnessError("options.now must be a valid date");
    }
  }
  const catalog = normalizeCatalog(catalogInput, provenanceInput, { now: options.now });
  const entries = Object.freeze(
    catalog.entries.map((entry) => Object.freeze(canonicalEntry(entry))),
  );
  const contentHash = computeContentHash(catalog.entries);
  // TOG-7660: provenance.snapshotHash covers the raw catalog body
  // (computeCatalogSnapshotHash), never the canonical-entry content hash, so
  // comparing the declared hash against contentHash could never verify.
  // Compare like with like: the declared hash against a recomputed body hash.
  // (normalizeCatalog already fail-closed on a mismatch via
  // verifyCatalogSnapshotHash, so this holds for every built snapshot.)
  const declaredHashVerified =
    computeCatalogSnapshotHash(catalogInput) === catalog.provenance.snapshotHash;

  let freshness = null;
  if (options.maxCatalogAgeMs !== undefined) {
    freshness = checkCatalogFreshness(catalog, {
      now: options.now ?? new Date(),
      maxCatalogAgeMs: options.maxCatalogAgeMs,
    });
  }

  const gaps = [];
  if (!declaredHashVerified) {
    gaps.push({
      routeId: null,
      gap: "declared-hash-unverified",
      detail:
        "declared provenance.snapshotHash does not match the recomputed catalog body hash; " +
        "treat the declared hash as a placeholder until it is regenerated from this catalog",
    });
  }
  if (freshness !== null && !freshness.fresh) {
    gaps.push({
      routeId: null,
      gap: freshness.ageMs < 0 ? "future-snapshot" : "stale-snapshot",
      detail:
        `snapshot age ${freshness.ageMs}ms exceeds limit ${freshness.maxCatalogAgeMs}ms ` +
        `(snapshotTimestamp ${freshness.snapshotTimestamp})`,
    });
  }
  for (const entry of entries) {
    gaps.push(...findEntryGaps(entry));
  }

  return Object.freeze({
    tool: "wayselect-snapshot",
    mode: "staging-only",
    sourcePrefix,
    collectedAt: normalizeCollectedAt(options.now),
    provenance: catalog.provenance,
    contentHash,
    declaredHashVerified,
    freshness,
    gaps: Object.freeze(gaps.map((gap) => Object.freeze(gap))),
    entries,
  });
}

export function snapshotIsClean(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new SnapshotError("snapshot must be a snapshot object");
  }
  if (!Array.isArray(snapshot.gaps)) {
    throw new SnapshotError("snapshot.gaps must be an array");
  }
  return snapshot.gaps.length === 0;
}
