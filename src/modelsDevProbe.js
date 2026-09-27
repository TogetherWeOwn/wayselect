// Single-run models.dev catalog freshness probe (TOG-5551).
//
// Read-only: diffs live models.dev route ids against the ingested fixture
// snapshot (added/removed/changed + provenance fields). The only networked
// path is an explicit `--fetch` of the public catalog URL (no credentials,
// no spend, no production writes). Stdlib only.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeQuarantine(routeId, reason) {
  return Object.freeze({ routeId, reason });
}

// Minimal-shape extraction of live models.dev input: provider-keyed object
// where each provider carries id/name/models and each model carries
// id/name. Capability fields are picked up when present for changed-field
// comparison; anything malformed is quarantined with a reason, never
// guessed. Returns { routes, quarantined, providerCount } where routes maps
// routeId -> frozen comparable record.
export function extractLiveRoutes(input) {
  if (!isPlainObject(input)) {
    throw new Error("live models.dev input must be an object keyed by provider id");
  }
  const providerKeys = Object.keys(input);
  if (providerKeys.length === 0) {
    throw new Error("live models.dev input must contain at least one provider");
  }
  const routes = new Map();
  const quarantined = [];
  let providerCount = 0;
  for (const providerKey of providerKeys.sort()) {
    const provider = input[providerKey];
    if (!isPlainObject(provider)) {
      quarantined.push(freezeQuarantine(providerKey, `provider ${providerKey} must be an object`));
      continue;
    }
    if (provider.id !== providerKey) {
      quarantined.push(
        freezeQuarantine(providerKey, `provider ${providerKey}.id must match its catalog key`),
      );
      continue;
    }
    if (typeof provider.name !== "string" || provider.name === "") {
      quarantined.push(
        freezeQuarantine(providerKey, `provider ${providerKey} must carry a non-empty name`),
      );
      continue;
    }
    if (!isPlainObject(provider.models)) {
      quarantined.push(
        freezeQuarantine(providerKey, `provider ${providerKey}.models must be an object`),
      );
      continue;
    }
    providerCount += 1;
    for (const modelKey of Object.keys(provider.models).sort()) {
      const routeId = `${providerKey}/${modelKey}`;
      const model = provider.models[modelKey];
      if (!isPlainObject(model)) {
        quarantined.push(freezeQuarantine(routeId, `model ${routeId} must be an object`));
        continue;
      }
      if (model.id !== modelKey) {
        quarantined.push(freezeQuarantine(routeId, `model ${routeId}.id must match its catalog key`));
        continue;
      }
      if (typeof model.name !== "string" || model.name === "") {
        quarantined.push(freezeQuarantine(routeId, `model ${routeId} must carry a non-empty name`));
        continue;
      }
      const modalities =
        isPlainObject(model.modalities) &&
        Array.isArray(model.modalities.input) &&
        Array.isArray(model.modalities.output)
          ? {
              input: [...model.modalities.input].sort(),
              output: [...model.modalities.output].sort(),
            }
          : null;
      const cost =
        isPlainObject(model.cost) &&
        Number.isFinite(model.cost.input) &&
        Number.isFinite(model.cost.output)
          ? { input: model.cost.input, output: model.cost.output }
          : null;
      routes.set(
        routeId,
        Object.freeze({
          routeId,
          providerId: providerKey,
          modelId: modelKey,
          name: model.name,
          attachment: typeof model.attachment === "boolean" ? model.attachment : null,
          reasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
          toolCall: typeof model.tool_call === "boolean" ? model.tool_call : null,
          structuredOutput:
            typeof model.structured_output === "boolean" ? model.structured_output : null,
          modalities,
          cost,
        }),
      );
    }
  }
  if (routes.size === 0) {
    throw new Error("no live routes survived extraction; refusing an empty diff");
  }
  return { routes, quarantined: Object.freeze(quarantined), providerCount };
}

// Comparable record for one normalized fixture entry. Normalized entries
// carry capabilities/toolUse/structuredOutput and rates; map them onto the
// live field names so overlap comparison is field-for-field.
export function fixtureRouteRecord(entry) {
  return Object.freeze({
    routeId: entry.routeId,
    providerId: entry.providerId,
    modelId: entry.modelId,
    name: entry.name,
    attachment: entry.capabilities?.attachment ?? null,
    reasoning: entry.capabilities?.reasoning ?? null,
    toolCall: entry.capabilities?.toolUse ?? null,
    structuredOutput: entry.capabilities?.structuredOutput ?? null,
    modalities: null,
    cost:
      entry.rates === null || entry.rates === undefined
        ? null
        : { input: entry.rates.inputPerMillion, output: entry.rates.outputPerMillion },
  });
}

const COMPARED_FIELDS = ["name", "attachment", "reasoning", "toolCall", "structuredOutput", "cost"];

function changedFields(previous, current) {
  const fields = {};
  let changed = false;
  for (const field of COMPARED_FIELDS) {
    const same = JSON.stringify(previous[field] ?? null) === JSON.stringify(current[field] ?? null);
    fields[field] = !same;
    if (!same) changed = true;
  }
  return { changed, fields };
}

// Set-diff of fixture routes vs live routes. Returns frozen added/removed/
// changed/unchanged route-id lists plus a summary. `changed` entries carry
// the per-field comparison for overlapping routes.
export function diffProbedRoutes(fixtureEntries, liveRoutes) {
  const fixtureByRoute = new Map();
  for (const entry of fixtureEntries) {
    fixtureByRoute.set(entry.routeId, fixtureRouteRecord(entry));
  }
  const liveByRoute = liveRoutes instanceof Map ? liveRoutes : new Map(liveRoutes);

  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [routeId, live] of liveByRoute) {
    const prior = fixtureByRoute.get(routeId);
    if (!prior) {
      added.push(routeId);
      continue;
    }
    const comparison = changedFields(prior, live);
    if (comparison.changed) {
      changed.push(Object.freeze({ routeId, ...comparison }));
    } else {
      unchanged.push(routeId);
    }
  }
  const removed = [];
  for (const routeId of fixtureByRoute.keys()) {
    if (!liveByRoute.has(routeId)) {
      removed.push(routeId);
    }
  }
  const sortIds = (list) => Object.freeze([...list].sort());
  return Object.freeze({
    added: sortIds(added),
    removed: sortIds(removed),
    changed: Object.freeze([...changed].sort((a, b) => (a.routeId < b.routeId ? -1 : 1))),
    unchanged: sortIds(unchanged),
    summary: Object.freeze({
      fixtureCount: fixtureByRoute.size,
      liveCount: liveByRoute.size,
      addedCount: added.length,
      removedCount: removed.length,
      changedCount: changed.length,
      unchangedCount: unchanged.length,
    }),
  });
}

// Provenance comparison: fixture pin vs live fetch stamp. Any field
// difference marks the provenance changed; the field map names each side.
export function compareProbeProvenance(fixtureProvenance, liveProvenance) {
  const fields = {
    source: [fixtureProvenance?.source ?? null, liveProvenance?.source ?? null],
    timestamp: [
      fixtureProvenance?.snapshotTimestamp ?? null,
      liveProvenance?.fetchedAt ?? null,
    ],
    hash: [fixtureProvenance?.snapshotHash ?? null, liveProvenance?.rawHash ?? null],
  };
  const changedFieldsList = Object.entries(fields)
    .filter(([, [left, right]]) => left !== right)
    .map(([field]) => field);
  return Object.freeze({
    changed: changedFieldsList.length > 0,
    fields: Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([field, [fixture, live]]) =>
          [field, Object.freeze({ fixture, live, changed: fixture !== live })],
        ),
      ),
    ),
  });
}

const SAMPLE_LIMIT = 50;

function sampleList(list) {
  return { sample: list.slice(0, SAMPLE_LIMIT), truncated: list.length > SAMPLE_LIMIT };
}

// Markdown probe report. Lists are sampled at SAMPLE_LIMIT with an explicit
// truncation note so an 8k-route live catalog cannot blow up the thread;
// counts are always exact.
export function formatProbeReport({
  fetchedAt,
  fetchSource,
  rawHash,
  fetchDurationMs,
  networkUsed,
  fixtureProvenance,
  fixtureCount,
  liveProviderCount,
  liveCount,
  quarantined,
  freshness,
  provenance,
  diff,
}) {
  const added = sampleList(diff.added);
  const removed = sampleList(diff.removed);
  const quarantinedSample = quarantined.slice(0, 20);
  const lines = [
    "# models.dev catalog freshness probe (TOG-5551)",
    "",
    `- fetched at: ${fetchedAt} (network ${networkUsed ? "used" : "not used"}: ${fetchSource})`,
    `- live input hash: ${rawHash} (${fetchDurationMs}ms; ${liveProviderCount} providers, ${liveCount} routes)`,
    `- fixture: ${fixtureProvenance.source} @ ${fixtureProvenance.snapshotTimestamp} (${fixtureCount} routes)`,
    `- fixture hash: ${fixtureProvenance.snapshotHash}`,
    `- freshness: ${freshness.fresh ? "fresh" : "STALE"} (age ${freshness.ageMs}ms, limit ${freshness.maxCatalogAgeMs}ms)`,
    `- diff: added ${diff.summary.addedCount}, removed ${diff.summary.removedCount}, ` +
      `changed ${diff.summary.changedCount}, unchanged ${diff.summary.unchangedCount}`,
    `- provenance changed: ${provenance.changed ? "yes" : "no"}`,
    `- quarantined live entries: ${quarantined.length}`,
    "",
  ];
  lines.push("## Provenance fields (fixture vs live)");
  for (const [field, { fixture, live, changed }] of Object.entries(provenance.fields)) {
    lines.push(`- ${field}: ${changed ? "CHANGED" : "same"} (fixture ${JSON.stringify(fixture)} vs live ${JSON.stringify(live)})`);
  }
  lines.push("");
  if (diff.added.length > 0) {
    lines.push(
      `## Added routes (${diff.summary.addedCount}${added.truncated ? `; first ${SAMPLE_LIMIT} shown` : ""})`,
      ...added.sample.map((route) => `- ${route}`),
      "",
    );
  }
  if (diff.removed.length > 0) {
    lines.push(
      `## Removed routes (${diff.summary.removedCount}${removed.truncated ? `; first ${SAMPLE_LIMIT} shown` : ""})`,
      ...removed.sample.map((route) => `- ${route}`),
      "",
    );
  }
  if (diff.changed.length > 0) {
    lines.push(`## Changed routes (${diff.summary.changedCount})`);
    for (const entry of diff.changed.slice(0, SAMPLE_LIMIT)) {
      const fields = Object.entries(entry.fields)
        .filter(([, flag]) => flag)
        .map(([field]) => field)
        .join(", ");
      lines.push(`- ${entry.routeId} (changed: ${fields || "none"})`);
    }
    if (diff.changed.length > SAMPLE_LIMIT) {
      lines.push(`- … and ${diff.changed.length - SAMPLE_LIMIT} more`);
    }
    lines.push("");
  }
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push("No route changes between fixture snapshot and live catalog.", "");
  }
  if (quarantined.length > 0) {
    lines.push(`## Quarantined live entries (${quarantined.length}; first ${quarantinedSample.length} shown)`);
    for (const entry of quarantinedSample) {
      lines.push(`- ${entry.routeId}: ${entry.reason}`);
    }
    lines.push("");
  }
  lines.push(
    "Interpretation: the in-repo fixture is a synthetic models.dev-shaped slice " +
      "(`synthetic://`), so large added/removed counts against the live upstream " +
      "catalog are expected drift, not a regression. Watch `changed` on overlapping " +
      "routes and the freshness verdict.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
