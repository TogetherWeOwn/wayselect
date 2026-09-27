export class SnapshotDiffError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotDiffError";
  }
}

function requireDiffEntry(entry, label) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new SnapshotDiffError(`${label} must be a snapshot entry object`);
  }
  if (typeof entry.routeId !== "string" || entry.routeId === "") {
    throw new SnapshotDiffError(`${label}.routeId must be a non-empty string`);
  }
  return entry;
}

function requireSnapshot(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotDiffError(`${label} must be a snapshot object`);
  }
  if (!Array.isArray(value.entries)) {
    throw new SnapshotDiffError(`${label}.entries must be an array`);
  }
  value.entries.forEach((entry, index) =>
    requireDiffEntry(entry, `${label}.entries[${index}]`),
  );
  if (value.gaps !== undefined && !Array.isArray(value.gaps)) {
    throw new SnapshotDiffError(`${label}.gaps must be an array when present`);
  }
  return value;
}

export function compareEntries(previous, current) {
  if (previous === null || typeof previous !== "object" || Array.isArray(previous)) {
    throw new SnapshotDiffError("previous entry must be a snapshot entry object");
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    throw new SnapshotDiffError("current entry must be a snapshot entry object");
  }
  return {
    changed: previous.name !== current.name,
    fields: {
      name: previous.name !== current.name,
      operations:
        JSON.stringify(previous.catalogOperations) !== JSON.stringify(current.catalogOperations),
      capabilities: JSON.stringify(previous.capabilities) !== JSON.stringify(current.capabilities),
      rates: JSON.stringify(previous.rates) !== JSON.stringify(current.rates),
    },
  };
}

export function diffSnapshots(previousInput, currentInput) {
  const previous = requireSnapshot(previousInput, "previous");
  const current = requireSnapshot(currentInput, "current");

  if (previous.sourcePrefix !== current.sourcePrefix) {
    throw new SnapshotDiffError("snapshots use different source prefixes; refusing to diff");
  }

  const previousByRoute = new Map(previous.entries.map((entry) => [entry.routeId, entry]));
  const currentByRoute = new Map(current.entries.map((entry) => [entry.routeId, entry]));

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const entry of current.entries) {
    const prior = previousByRoute.get(entry.routeId);
    if (!prior) {
      added.push(entry.routeId);
      continue;
    }
    const comparison = compareEntries(prior, entry);
    if (comparison.changed) {
      changed.push({ routeId: entry.routeId, ...comparison });
    } else if (
      comparison.fields.operations ||
      comparison.fields.capabilities ||
      comparison.fields.rates
    ) {
      changed.push({ routeId: entry.routeId, ...comparison });
    } else {
      unchanged.push(entry.routeId);
    }
  }

  for (const entry of previous.entries) {
    if (!currentByRoute.has(entry.routeId)) {
      removed.push(entry.routeId);
    }
  }

  const sortRouteIds = (list) => [...list].sort();
  const gapKey = (gap) => JSON.stringify(gap);
  const previousGapKeys = new Set((previous.gaps ?? []).map(gapKey));
  const currentGapKeys = new Set((current.gaps ?? []).map(gapKey));
  const currentGaps = (current.gaps ?? []).map((gap) => ({ ...gap }));
  const newGaps = currentGaps.filter((gap) => !previousGapKeys.has(gapKey(gap)));
  const resolvedGaps = (previous.gaps ?? []).filter((gap) => !currentGapKeys.has(gapKey(gap)));

  const summary = Object.freeze({
    routeCountBefore: previous.entries.length,
    routeCountAfter: current.entries.length,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    provenanceChanged:
      JSON.stringify(previous.provenance) !== JSON.stringify(current.provenance),
    contentHashChanged: previous.contentHash !== current.contentHash,
    gapDelta: currentGaps.length - (previous.gaps ?? []).length,
  });

  return Object.freeze({
    tool: "wayselect-snapshot-diff",
    mode: "staging-only",
    previousContentHash: previous.contentHash,
    currentContentHash: current.contentHash,
    previousProvenance: previous.provenance,
    currentProvenance: current.provenance,
    added: Object.freeze(sortRouteIds(added)),
    removed: Object.freeze(sortRouteIds(removed)),
    changed: Object.freeze(changed),
    unchanged: Object.freeze(sortRouteIds(unchanged)),
    newGaps: Object.freeze(newGaps.map((gap) => Object.freeze(gap))),
    resolvedGaps: Object.freeze(resolvedGaps.map((gap) => Object.freeze(gap))),
    currentGaps: Object.freeze(currentGaps.map((gap) => Object.freeze(gap))),
    summary,
  });
}

function requireDiffReport(diff) {
  if (diff === null || typeof diff !== "object" || Array.isArray(diff)) {
    throw new SnapshotDiffError("diff must be a snapshot diff object");
  }
  for (const field of ["added", "removed", "changed", "newGaps", "resolvedGaps", "currentGaps"]) {
    if (!Array.isArray(diff[field])) {
      throw new SnapshotDiffError(`diff.${field} must be an array`);
    }
  }
  if (diff.summary === null || typeof diff.summary !== "object" || Array.isArray(diff.summary)) {
    throw new SnapshotDiffError("diff.summary must be an object");
  }
  return diff;
}

function formatGapLine(gap) {
  const detail =
    typeof gap.detail === "string" && gap.detail !== "" ? ` — ${gap.detail}` : "";
  return `- ${gap.routeId ?? "(snapshot)"}: ${gap.gap}${detail}`;
}

export function formatDiffReport(diffInput) {
  const diff = requireDiffReport(diffInput);
  // Gap counts are derived from the frozen gap sets (no diff-shape change):
  // previous open = current open - new + resolved, compared by gap key.
  const gapCountAfter = diff.currentGaps.length;
  const gapCountBefore = gapCountAfter - diff.newGaps.length + diff.resolvedGaps.length;
  const gapDeltaWords =
    diff.newGaps.length === 0 && diff.resolvedGaps.length === 0
      ? "no change"
      : `+${diff.newGaps.length} new, -${diff.resolvedGaps.length} resolved`;
  const lines = [
    "# Wayselect staging catalog snapshot diff",
    "",
    `- previous content hash: ${diff.previousContentHash}`,
    `- current content hash: ${diff.currentContentHash}`,
    `- routes: ${diff.summary.routeCountBefore} -> ${diff.summary.routeCountAfter} ` +
      `(added ${diff.summary.addedCount}, removed ${diff.summary.removedCount}, ` +
      `changed ${diff.summary.changedCount}, unchanged ${diff.summary.unchangedCount})`,
    `- provenance changed: ${diff.summary.provenanceChanged ? "yes" : "no"}`,
    `- content hash changed: ${diff.summary.contentHashChanged ? "yes" : "no"}`,
    `- gaps: ${gapCountBefore} -> ${gapCountAfter} ` +
      `(new ${diff.newGaps.length}, resolved ${diff.resolvedGaps.length})`,
    "",
  ];

  if (diff.added.length > 0) {
    lines.push("## Added routes", ...diff.added.map((route) => `- ${route}`), "");
  }
  if (diff.removed.length > 0) {
    lines.push("## Removed routes", ...diff.removed.map((route) => `- ${route}`), "");
  }
  if (diff.changed.length > 0) {
    lines.push("## Changed routes");
    for (const entry of diff.changed) {
      const fields = Object.entries(entry.fields)
        .filter(([, changedFlag]) => changedFlag)
        .map(([field]) => field)
        .join(", ");
      lines.push(`- ${entry.routeId} (changed: ${fields || "none"})`);
    }
    lines.push("");
  }
  if (diff.newGaps.length > 0) {
    lines.push("## New provenance gaps", ...diff.newGaps.map(formatGapLine), "");
  }
  if (diff.resolvedGaps.length > 0) {
    lines.push(
      "## Resolved provenance gaps",
      ...diff.resolvedGaps.map(formatGapLine),
      "",
    );
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push(
      `No route changes between snapshots (${diff.summary.unchangedCount} unchanged; ` +
        `content hash ${diff.summary.contentHashChanged ? "changed" : "unchanged"}).`,
      "",
    );
  }
  if (diff.currentGaps.length === 0) {
    lines.push("Provenance gaps: none. The current snapshot is clean.", "");
  } else {
    lines.push(
      "## Provenance gaps",
      `Open gaps on current snapshot: ${gapCountAfter} (${gapDeltaWords} since previous).`,
      ...diff.currentGaps.map(formatGapLine),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
