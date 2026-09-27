// Snapshot retention planner for Wayselect (TOG-5740).
//
// `snapshots/` accumulates timestamped `snapshot-*.json` files with no
// previous retention rule. This module is the policy boundary: given a
// directory listing it decides what to keep and what to prune, and it never
// touches anything that is not a snapshot file.
//
// Policy (see docs/snapshot-retention.md):
//   - Only files matching `snapshot-*.json` are ever prune candidates.
//     Diff reports (`diff-report-*.md`, `sample-*.md`) and anything else in
//     the directory is always skipped.
//   - The N newest snapshots are always kept, regardless of age, so a prune
//     can never empty the directory (keep-last floor, default 10).
//   - A snapshot older than the keep floor is pruned only when it is also
//     older than the max age (default 30 days).
//
// Pure + stdlib only: no filesystem access here (the CLI in
// bin/wayselect-snapshot-prune lists and deletes); tests drive this module
// with synthetic listings and the CLI tests run against scratch copies.

export const DEFAULT_KEEP_LAST = 10;
export const DEFAULT_MAX_AGE_DAYS = 30;
export const SNAPSHOT_FILE_PATTERN = /^snapshot-.*\.json$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SnapshotPruneError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotPruneError";
  }
}

function requireKeepLast(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new SnapshotPruneError("options.keepLast must be a positive integer");
  }
  return value;
}

function requireMaxAgeDays(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SnapshotPruneError("options.maxAgeDays must be a non-negative number");
  }
  return value;
}

function requireNowMs(value) {
  const ms =
    typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new SnapshotPruneError("options.now must be a valid date");
  }
  return ms;
}

function requireListing(files) {
  if (!Array.isArray(files)) {
    throw new SnapshotPruneError("files must be an array");
  }
  for (const [index, entry] of files.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SnapshotPruneError(`files[${index}] must be a { name, mtimeMs } object`);
    }
    if (typeof entry.name !== "string" || entry.name === "") {
      throw new SnapshotPruneError(`files[${index}].name must be a non-empty string`);
    }
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) {
      throw new SnapshotPruneError(`files[${index}].mtimeMs must be a finite number`);
    }
  }
  return files;
}

function compareNewestFirst(left, right) {
  if (left.mtimeMs !== right.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  if (left.name < right.name) {
    return 1;
  }
  if (left.name > right.name) {
    return -1;
  }
  return 0;
}

// Plan a prune over a directory listing. Entries are { name, mtimeMs }.
// Returns a frozen { kept, pruned, skipped } of file names: skipped holds
// every non-snapshot name (never a deletion candidate); kept holds the
// keep-last floor plus young overflow; pruned holds old overflow only.
export function planSnapshotPrune(files, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new SnapshotPruneError("options must be an object when present");
  }
  const keepLast = requireKeepLast(options.keepLast ?? DEFAULT_KEEP_LAST);
  const maxAgeDays = requireMaxAgeDays(options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);
  const nowMs = options.now === undefined ? Date.now() : requireNowMs(options.now);
  requireListing(files);

  const skipped = files
    .filter((entry) => !SNAPSHOT_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  const candidates = files
    .filter((entry) => SNAPSHOT_FILE_PATTERN.test(entry.name))
    .sort(compareNewestFirst);

  const maxAgeMs = maxAgeDays * DAY_MS;
  const kept = [];
  const pruned = [];
  for (const [rank, entry] of candidates.entries()) {
    const old = entry.mtimeMs < nowMs - maxAgeMs;
    if (rank < keepLast || !old) {
      kept.push(entry.name);
    } else {
      pruned.push(entry.name);
    }
  }

  return Object.freeze({
    kept: Object.freeze([...kept]),
    pruned: Object.freeze([...pruned]),
    skipped: Object.freeze([...skipped]),
  });
}
