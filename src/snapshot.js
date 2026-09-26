import { createHash } from "node:crypto";
import { normalizeCatalog } from "./catalog.js";
import { checkCatalogFreshness } from "./freshness.js";

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
  const canonical = [...entries].map(canonicalEntry).sort(compareRouteId);
  return `sha256:${createHash("sha256").update(stableStringify(canonical)).digest("hex")}`;
}

export function findEntryGaps(entry) {
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
  const sourcePrefix = options.sourcePrefix ?? DEFAULT_STAGING_SOURCE_PREFIX;
  const declaredSource = provenanceInput?.source;
  if (typeof declaredSource !== "string" || !declaredSource.startsWith(sourcePrefix)) {
    throw new SnapshotError(
      `refusing non-staging catalog source: ${JSON.stringify(declaredSource)} ` +
        `(staging-only snapshot; expected source prefix ${JSON.stringify(sourcePrefix)})`,
    );
  }

  const catalog = normalizeCatalog(catalogInput, provenanceInput);
  const entries = Object.freeze(
    catalog.entries.map((entry) => Object.freeze(canonicalEntry(entry))),
  );
  const contentHash = computeContentHash(catalog.entries);
  const declaredHashVerified = catalog.provenance.snapshotHash === contentHash;

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
        "declared provenance.snapshotHash does not match the recomputed content hash; " +
        "treat the declared hash as a placeholder until it is regenerated from this snapshot",
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
  return snapshot.gaps.length === 0;
}
