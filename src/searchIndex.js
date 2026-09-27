// Search-index refresh for the Wayselect catalog surface (TOG-5460).
//
// Fixture-only: stdlib only, no network access, no credentials, no backend
// writes outside an explicit --out directory. Derives a frozen, searchable
// view over the fixture catalog through the same normalizeCatalog boundary
// the CLI uses, so the index can never describe routes the catalog boundary
// would reject.
//
// Two mechanics, both idempotent:
//
//   buildSearchIndex  — catalog + provenance in, frozen index out.
//   reloadSearchIndex — previous index + catalog + provenance in, frozen
//                       { changed, index } out. Identical input yields
//                       changed:false and a deep-equal index.
//
// Queued jobs: createRefreshQueue holds one current index and a FIFO of
// pending refresh requests. Enqueueing an identical request while it is still
// pending returns the existing job (deduped:true) instead of stacking work;
// drain processes pending jobs in order and records per-job results.
//
// Stale or future-dated catalogs are reported on the index (freshness), and
// the CLI enforces fail-closed; the library never throws on age alone.
// Non-`synthetic://` sources are refused at the boundary.

import { computeCatalogSnapshotHash, normalizeCatalog } from "./catalog.js";
import { checkCatalogFreshness } from "./freshness.js";
import { computeContentHash } from "./snapshot.js";

export const SEARCH_INDEX_TOOL = "wayselect-search-index";
export const SEARCH_INDEX_MODE = "fixture-only";
export const DEFAULT_SEARCH_INDEX_SOURCE_PREFIX = "synthetic://";

export class SearchIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = "SearchIndexError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireSourcePrefix(value) {
  if (typeof value !== "string" || value === "") {
    throw new SearchIndexError("options.sourcePrefix must be a non-empty string when present");
  }
  return value;
}

function providerNameFor(catalogInput, providerId) {
  const provider = catalogInput?.[providerId];
  if (isRecord(provider) && typeof provider.name === "string" && provider.name !== "") {
    return provider.name;
  }
  return providerId;
}

function indexEntryFor(entry, catalogInput) {
  const providerName = providerNameFor(catalogInput, entry.providerId);
  const searchText = `${entry.name} ${entry.routeId} ${providerName}`.toLowerCase();
  return Object.freeze({
    routeId: entry.routeId,
    providerId: entry.providerId,
    modelId: entry.modelId,
    name: entry.name,
    providerName,
    searchText,
    catalogOperations: Object.freeze([...entry.catalogOperations]),
    capabilities: Object.freeze({ ...entry.capabilities }),
    rates: entry.rates
      ? Object.freeze({
          inputPerMillion: entry.rates.inputPerMillion,
          outputPerMillion: entry.rates.outputPerMillion,
        })
      : null,
  });
}

function normalizeCollectedAt(value) {
  const collectedAt = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(collectedAt.getTime())) {
    throw new SearchIndexError("options.now must be a valid date");
  }
  return collectedAt.toISOString();
}

export function buildSearchIndex(catalogInput, provenanceInput, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SearchIndexError("options must be an object when present");
  }
  const sourcePrefix =
    options.sourcePrefix === undefined
      ? DEFAULT_SEARCH_INDEX_SOURCE_PREFIX
      : requireSourcePrefix(options.sourcePrefix);
  const declaredSource = provenanceInput?.source;
  if (typeof declaredSource !== "string" || !declaredSource.startsWith(sourcePrefix)) {
    throw new SearchIndexError(
      `refusing non-staging catalog source: ${JSON.stringify(declaredSource)} ` +
        `(fixture-only search index; expected source prefix ${JSON.stringify(sourcePrefix)})`,
    );
  }

  const catalog = normalizeCatalog(catalogInput, provenanceInput);
  const entries = Object.freeze(catalog.entries.map((entry) => indexEntryFor(entry, catalogInput)));
  const contentHash = computeContentHash(catalog.entries);

  let freshness = null;
  if (options.maxCatalogAgeMs !== undefined) {
    freshness = checkCatalogFreshness(catalog, {
      now: options.now ?? new Date(),
      maxCatalogAgeMs: options.maxCatalogAgeMs,
    });
  }

  return Object.freeze({
    tool: SEARCH_INDEX_TOOL,
    mode: SEARCH_INDEX_MODE,
    sourcePrefix,
    collectedAt: normalizeCollectedAt(options.now),
    provenance: Object.freeze({
      source: catalog.provenance.source,
      snapshotTimestamp: catalog.provenance.snapshotTimestamp,
      snapshotHash: catalog.provenance.snapshotHash,
    }),
    contentHash,
    freshness,
    entries,
  });
}

function requireIndex(value, label) {
  if (!isRecord(value)) {
    throw new SearchIndexError(`${label} must be a search index object`);
  }
  if (value.tool !== SEARCH_INDEX_TOOL) {
    throw new SearchIndexError(
      `${label}.tool: expected ${JSON.stringify(SEARCH_INDEX_TOOL)}, got ${JSON.stringify(value.tool)}`,
    );
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new SearchIndexError(`${label}.entries must be a non-empty array`);
  }
  if (typeof value.contentHash !== "string" || value.contentHash === "") {
    throw new SearchIndexError(`${label}.contentHash must be a non-empty string`);
  }
  return value;
}

export function reloadSearchIndex(previousIndex, catalogInput, provenanceInput, options = {}) {
  const previous = requireIndex(previousIndex, "previousIndex");
  const next = buildSearchIndex(catalogInput, provenanceInput, options);
  const changed = next.contentHash !== previous.contentHash;
  return Object.freeze({
    changed,
    index: next,
    previousContentHash: previous.contentHash,
    contentHash: next.contentHash,
  });
}

// Queue key: the tamper-evident body hash plus the provenance stamp. The same
// catalog body stamped at the same time is the same refresh request.
function queueKey(catalogInput, provenanceInput) {
  const snapshotTimestamp =
    isRecord(provenanceInput) && typeof provenanceInput.snapshotTimestamp === "string"
      ? provenanceInput.snapshotTimestamp
      : "unknown-timestamp";
  let bodyHash;
  try {
    bodyHash = computeCatalogSnapshotHash(catalogInput);
  } catch {
    bodyHash = "unhashable-body";
  }
  return `${bodyHash}@${snapshotTimestamp}`;
}

export function createRefreshQueue(seed = {}) {
  if (seed === null || typeof seed !== "object" || Array.isArray(seed)) {
    throw new SearchIndexError("seed must be an object when present");
  }
  let current =
    seed.initialIndex === undefined ? null : requireIndex(seed.initialIndex, "seed.initialIndex");
  const pending = [];
  let sequence = 0;

  function enqueue(catalogInput, provenanceInput, options = {}) {
    const key = queueKey(catalogInput, provenanceInput);
    const existing = pending.find((job) => job.key === key);
    if (existing) {
      return Object.freeze({ ...existing, deduped: true });
    }
    sequence += 1;
    const job = Object.freeze({
      jobId: `refresh-${sequence}`,
      key,
      enqueuedAt: normalizeCollectedAt(options?.now),
      catalogInput,
      provenanceInput,
      options: Object.freeze({ ...(options ?? {}) }),
      deduped: false,
    });
    pending.push(job);
    return job;
  }

  function drain() {
    const results = [];
    while (pending.length > 0) {
      const job = pending.shift();
      const outcome =
        current === null
          ? {
              changed: true,
              index: buildSearchIndex(job.catalogInput, job.provenanceInput, job.options),
              previousContentHash: null,
            }
          : reloadSearchIndex(current, job.catalogInput, job.provenanceInput, job.options);
      current = outcome.index;
      results.push(
        Object.freeze({
          jobId: job.jobId,
          changed: outcome.changed,
          previousContentHash: outcome.previousContentHash,
          contentHash: outcome.contentHash,
          routeCount: outcome.index.entries.length,
        }),
      );
    }
    return Object.freeze(results);
  }

  return Object.freeze({
    enqueue,
    drain,
    pendingCount() {
      return pending.length;
    },
    currentIndex() {
      return current;
    },
  });
}

// Refresh probe: the done-criteria check for TOG-5460. Builds the index from
// the given fixtures, rebuilds, and reloads; every check must hold for ok to
// be true. Currency against a freshness window is evaluated only when
// options.maxCatalogAgeMs is provided.
export function probeSearchIndexRefresh(catalogInput, provenanceInput, options = {}) {
  const checks = [];
  const note = (id, ok, detail) => {
    checks.push(Object.freeze({ id, ok, detail }));
  };

  let first = null;
  try {
    first = buildSearchIndex(catalogInput, provenanceInput, options);
    note("R1-source", true, `staging source ${first.provenance.source}`);
  } catch (error) {
    note("R1-source", false, error instanceof Error ? error.message : String(error));
    return Object.freeze({ ok: false, contentHash: null, checks: Object.freeze(checks) });
  }

  try {
    const catalog = normalizeCatalog(catalogInput, provenanceInput);
    const expected = new Set(catalog.entries.map((entry) => entry.routeId));
    const actual = new Set(first.entries.map((entry) => entry.routeId));
    const missing = [...expected].filter((route) => !actual.has(route));
    const extra = [...actual].filter((route) => !expected.has(route));
    const parity =
      missing.length === 0 && extra.length === 0 && first.entries.length === expected.size;
    note(
      "R2-parity",
      parity,
      parity
        ? `${first.entries.length} index entries cover every catalog route`
        : `missing ${missing.join(",") || "none"}; extra ${extra.join(",") || "none"}`,
    );
  } catch (error) {
    note("R2-parity", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const second = buildSearchIndex(catalogInput, provenanceInput, options);
    const stable = second.contentHash === first.contentHash;
    note(
      "R3-stable",
      stable,
      stable
        ? `consecutive builds agree on ${first.contentHash}`
        : `rebuild drifted ${first.contentHash} -> ${second.contentHash}`,
    );
  } catch (error) {
    note("R3-stable", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const reload = reloadSearchIndex(first, catalogInput, provenanceInput, options);
    // changed:false already means contentHash equality (reload derives changed
    // from the hash comparison), which proves identical input; no entry
    // stringify needed on top for frozen plain data.
    const idempotent =
      reload.changed === false && reload.contentHash === first.contentHash;
    note(
      "R4-idempotent",
      idempotent,
      idempotent
        ? `reload reports changed:false at ${reload.contentHash}`
        : `reload reported changed:${reload.changed}`,
    );
  } catch (error) {
    note("R4-idempotent", false, error instanceof Error ? error.message : String(error));
  }

  if (first.freshness !== null) {
    const fresh = first.freshness.fresh === true;
    note(
      "R5-fresh",
      fresh,
      fresh
        ? `snapshot age ${first.freshness.ageMs}ms within ${first.freshness.maxCatalogAgeMs}ms`
        : `snapshot age ${first.freshness.ageMs}ms exceeds limit ${first.freshness.maxCatalogAgeMs}ms`,
    );
  } else {
    note("R5-fresh", true, "no freshness window provided; currency not evaluated");
  }

  return Object.freeze({
    ok: checks.every((entry) => entry.ok),
    contentHash: first.contentHash,
    checks: Object.freeze(checks),
  });
}
