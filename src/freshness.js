export class CatalogFreshnessError extends Error {
  constructor(message) {
    super(message);
    this.name = "CatalogFreshnessError";
  }
}

export class CatalogStaleError extends Error {
  constructor(message, { ageMs, maxCatalogAgeMs, snapshotTimestamp } = {}) {
    super(message);
    this.name = "CatalogStaleError";
    this.ageMs = ageMs;
    this.maxCatalogAgeMs = maxCatalogAgeMs;
    this.snapshotTimestamp = snapshotTimestamp;
  }
}

function normalizeNow(value) {
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new CatalogFreshnessError("options.now must be a valid date");
  }
  return now;
}

function normalizeMaxCatalogAgeMs(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new CatalogFreshnessError(
      "options.maxCatalogAgeMs must be a non-negative number",
    );
  }
  return value;
}

function snapshotTimestampMs(catalog) {
  const timestamp = catalog?.provenance?.snapshotTimestamp;
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new CatalogFreshnessError(
      "catalog.provenance.snapshotTimestamp must be an ISO timestamp",
    );
  }
  return parsed;
}

export function checkCatalogFreshness(catalog, options) {
  const now = normalizeNow(options?.now);
  const maxCatalogAgeMs = normalizeMaxCatalogAgeMs(options?.maxCatalogAgeMs);
  const snapshotMs = snapshotTimestampMs(catalog);
  const ageMs = now.getTime() - snapshotMs;
  const fresh = ageMs >= 0 && ageMs <= maxCatalogAgeMs;

  return Object.freeze({
    fresh,
    ageMs,
    snapshotTimestamp: new Date(snapshotMs).toISOString(),
    maxCatalogAgeMs,
  });
}

export function requireFreshCatalog(catalog, options) {
  const probe = checkCatalogFreshness(catalog, options);
  if (!probe.fresh) {
    const state = probe.ageMs < 0 ? "in the future" : "stale";
    throw new CatalogStaleError(
      `catalog snapshot ${probe.snapshotTimestamp} is ${state} ` +
        `(age ${probe.ageMs}ms, limit ${probe.maxCatalogAgeMs}ms)`,
      {
        ageMs: probe.ageMs,
        maxCatalogAgeMs: probe.maxCatalogAgeMs,
        snapshotTimestamp: probe.snapshotTimestamp,
      },
    );
  }
  return probe;
}
