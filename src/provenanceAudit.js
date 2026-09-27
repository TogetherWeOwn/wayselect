// Provenance backfill audit for Wayselect ingestion pipeline output (TOG-5289).
//
// Follow-up to the nightly smoke (TOG-5246): where the smoke exercises the
// live pipeline boundaries in memory, this module audits the persisted
// pipeline outputs on disk — the committed staging snapshot backfill files
// in snapshots/. Every backfill must carry pinned provenance (source + hash
// + timestamp), every entry must be traceable to that provenance, the
// recomputed content hash must match (tamper-evident), and stale backfills
// are flagged as failures.
//
// Per-entry traceability is verified through the pinning chain rather than
// per-entry stamp fields: each entry carries routeId/providerId/modelId,
// and the snapshot contentHash covers every entry, so a tampered or
// swapped entry breaks the hash. No network, no credentials, no spend.

import { checkCatalogFreshness } from "./freshness.js";
import { computeContentHash } from "./snapshot.js";

export class ProvenanceAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvenanceAuditError";
  }
}

export const DEFAULT_BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const EXPECTED_BACKFILL_TOOL = "wayselect-snapshot";
export const EXPECTED_BACKFILL_MODE = "staging-only";
export const EXPECTED_BACKFILL_SOURCE_PREFIX = "synthetic://";

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function auditEntries(entries, failures) {
  if (!Array.isArray(entries) || entries.length === 0) {
    failures.push("entries: snapshot must contain a non-empty entries array");
    return 0;
  }
  entries.forEach((entry, index) => {
    const label = `entries[${index}]`;
    if (!isRecord(entry)) {
      failures.push(`${label}: entry must be an object`);
      return;
    }
    if (typeof entry.routeId !== "string" || entry.routeId === "") {
      failures.push(`${label}: missing routeId (entry not traceable to source)`);
    }
    if (typeof entry.providerId !== "string" || entry.providerId === "") {
      failures.push(`${label}: missing providerId`);
    }
    if (typeof entry.modelId !== "string" || entry.modelId === "") {
      failures.push(`${label}: missing modelId`);
    }
    if (
      typeof entry.routeId === "string" &&
      typeof entry.providerId === "string" &&
      typeof entry.modelId === "string" &&
      entry.routeId !== "" &&
      entry.routeId !== `${entry.providerId}/${entry.modelId}`
    ) {
      failures.push(
        `${label}: routeId ${JSON.stringify(entry.routeId)} does not match ` +
          `${JSON.stringify(`${entry.providerId}/${entry.modelId}`)}`,
      );
    }
    if (typeof entry.name !== "string" || entry.name === "") {
      failures.push(`${label}: missing name`);
    }
    if (
      !Array.isArray(entry.catalogOperations) ||
      entry.catalogOperations.some((item) => typeof item !== "string" || item === "")
    ) {
      failures.push(`${label}: catalogOperations must be an array of non-empty strings`);
    }
    if (!isRecord(entry.capabilities)) {
      failures.push(`${label}: capabilities must be an object`);
    }
  });
  return entries.length;
}

export function auditIngestionSnapshot(snapshot, options = {}) {
  if (!isRecord(snapshot)) {
    throw new ProvenanceAuditError("snapshot must be a snapshot object");
  }
  if (options === undefined) {
    options = {};
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new ProvenanceAuditError("options must be an object when present");
  }
  const opts = options;
  const filename = opts.filename ?? "<inline>";
  const maxCatalogAgeMs =
    opts.maxCatalogAgeMs === undefined ? DEFAULT_BACKFILL_MAX_AGE_MS : opts.maxCatalogAgeMs;
  if (!Number.isFinite(maxCatalogAgeMs) || maxCatalogAgeMs < 0) {
    throw new ProvenanceAuditError("options.maxCatalogAgeMs must be a non-negative number");
  }

  const failures = [];

  if (snapshot.tool !== EXPECTED_BACKFILL_TOOL) {
    failures.push(`tool: expected ${JSON.stringify(EXPECTED_BACKFILL_TOOL)}, got ${JSON.stringify(snapshot.tool)}`);
  }
  if (snapshot.mode !== EXPECTED_BACKFILL_MODE) {
    failures.push(`mode: expected ${JSON.stringify(EXPECTED_BACKFILL_MODE)}, got ${JSON.stringify(snapshot.mode)}`);
  }
  if (snapshot.sourcePrefix !== EXPECTED_BACKFILL_SOURCE_PREFIX) {
    failures.push(
      `sourcePrefix: expected ${JSON.stringify(EXPECTED_BACKFILL_SOURCE_PREFIX)}, ` +
        `got ${JSON.stringify(snapshot.sourcePrefix)}`,
    );
  }

  const provenance = isRecord(snapshot.provenance) ? snapshot.provenance : null;
  if (provenance === null) {
    failures.push("provenance: snapshot must carry a provenance block");
  } else {
    if (
      typeof provenance.source !== "string" ||
      !provenance.source.startsWith(EXPECTED_BACKFILL_SOURCE_PREFIX)
    ) {
      failures.push(
        `provenance.source: must start with ${JSON.stringify(EXPECTED_BACKFILL_SOURCE_PREFIX)}, ` +
          `got ${JSON.stringify(provenance.source)}`,
      );
    }
    if (typeof provenance.snapshotTimestamp !== "string" || !Number.isFinite(Date.parse(provenance.snapshotTimestamp))) {
      failures.push(
        `provenance.snapshotTimestamp: must be an ISO timestamp, got ${JSON.stringify(provenance.snapshotTimestamp)}`,
      );
    }
    if (typeof provenance.snapshotHash !== "string" || !HASH_PATTERN.test(provenance.snapshotHash)) {
      failures.push(
        "provenance.snapshotHash: must use the form sha256:<64 lowercase hex characters>, " +
          `got ${JSON.stringify(provenance.snapshotHash)}`,
      );
    }
  }

  const collectedAt = snapshot.collectedAt;
  if (typeof collectedAt !== "string" || !Number.isFinite(Date.parse(collectedAt))) {
    failures.push(`collectedAt: must be an ISO timestamp, got ${JSON.stringify(collectedAt)}`);
  }

  const entryCount = auditEntries(snapshot.entries, failures);

  let contentHashVerified = false;
  if (typeof snapshot.contentHash !== "string" || !HASH_PATTERN.test(snapshot.contentHash)) {
    failures.push(
      "contentHash: must use the form sha256:<64 lowercase hex characters>, " +
        `got ${JSON.stringify(snapshot.contentHash)}`,
    );
  } else {
    try {
      const recomputed = computeContentHash(snapshot.entries);
      contentHashVerified = recomputed === snapshot.contentHash;
      if (!contentHashVerified) {
        failures.push(
          "contentHash: recomputed hash does not match the recorded hash " +
            `(recorded ${snapshot.contentHash}, recomputed ${recomputed}); ` +
            "backfill may be tampered or edited by hand",
        );
      }
    } catch (error) {
      failures.push(
        `contentHash: could not recompute over entries (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  // Freshness is evaluated at ingestion time (collectedAt) by default so the
  // audit of committed backfills stays deterministic; pass options.now to
  // evaluate currency against a specific reference time instead.
  let freshness = null;
  const referenceNow = opts.now === undefined ? collectedAt : opts.now;
  try {
    freshness = checkCatalogFreshness(
      { provenance: { snapshotTimestamp: provenance?.snapshotTimestamp } },
      { now: referenceNow, maxCatalogAgeMs },
    );
    if (!freshness.fresh) {
      failures.push(
        freshness.ageMs < 0
          ? `future-backfill: collected ${freshness.ageMs}ms before snapshotTimestamp ${freshness.snapshotTimestamp}`
          : `stale-backfill: age ${freshness.ageMs}ms exceeds limit ${freshness.maxCatalogAgeMs}ms ` +
            `(snapshotTimestamp ${freshness.snapshotTimestamp})`,
      );
    }
  } catch (error) {
    failures.push(
      `freshness: could not evaluate (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return Object.freeze({
    filename,
    ok: failures.length === 0,
    failures: Object.freeze([...failures]),
    entryCount,
    contentHash: typeof snapshot.contentHash === "string" ? snapshot.contentHash : null,
    contentHashVerified,
    // Recorded, not gated: committed backfills may carry a placeholder
    // declared hash until it is regenerated from the snapshot body.
    declaredHashVerified: snapshot.declaredHashVerified === true,
    provenance: Object.freeze({
      source: provenance?.source ?? null,
      snapshotTimestamp: provenance?.snapshotTimestamp ?? null,
      snapshotHash: provenance?.snapshotHash ?? null,
      collectedAt: typeof collectedAt === "string" ? collectedAt : null,
    }),
    freshness,
  });
}
