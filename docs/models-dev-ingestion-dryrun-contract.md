# models.dev ingestion dry-run contract (TOG-5756, supports TOG-4791)

Pinned interface for the [TOG-4791](/TOG/issues/TOG-4791) ingestion adapter
(`src/ingest.js`, `ingestModelsDev`): fixture shape in, normalized catalog
out. Proven by `test/models-dev-ingestion-dryrun-contract.test.js` against
small newly-authored synthetic input — no network, no credentials, no
redistributed snapshot.

## Shape in: models.dev-shaped JSON

A provider-keyed object. Each provider carries `id` (must match its key),
`name`, and `models`; each model carries `id` (must match its key), `name`,
and any subset of the mapped fields below.

| models.dev field | Catalog field | Notes |
| --- | --- | --- |
| `attachment`, `reasoning`, `tool_call`, `structured_output` | same names (`tool_call` → `toolUse` at normalization) | optional booleans; absent means unknown, never guessed |
| `modalities: {input[], output[]}` | same | non-empty string arrays; derive `chat` / `vision-chat` operations |
| `cost: {input, output}` | same | list prices only; siblings (`cache_read`, …) are stripped |
| `limit: {context, output}` | `context_window`, `max_output_tokens` | each present side maps; absent stays absent (null downstream) |

Known upstream extras are stripped at the boundary, never guessed as
capabilities: `api`, `doc`, `endpoint` (URL-bearing — ingestion must never
emit an executable location), plus `temperature`, `knowledge`,
`release_date`, `open_weights` card metadata. Anything else unknown, or any
malformed field, quarantines that entry with a named reason
(`unknown field: <key>`, `must match its catalog key`, the underlying
validation message); the rest of the input still ingests.

## Call: `ingestModelsDev(input, options)`

- `options.source` (required, non-empty string): provenance source label.
- `options.snapshotTimestamp` (optional ISO, defaults to now).
- `options.snapshotHash` (optional): must equal the canonical SHA-256 body
  hash of the ingested mapping, else `IngestError` — an explicit hash that
  does not match fails closed instead of writing an unverifiable document.
- Non-object or provider-less input throws `IngestError`.

Returns a frozen `{ catalog, provenance, quarantined }`:

- `catalog`: provider-keyed catalog input, ready for `normalizeCatalog`.
- `provenance`: frozen `{ source, snapshotTimestamp, snapshotHash }` where
  the default `snapshotHash` IS the canonical body hash
  (`computeCatalogSnapshotHash`), so default output always passes
  `normalizeCatalog`'s snapshot-hash gate.
- `quarantined`: frozen `[{ routeId, reason }]` for every dropped
  provider/model; kept entries are guaranteed to normalize cleanly
  (each survived a trial normalization before being kept).

## Shape out: normalized catalog + dry-run pipeline

- `normalizeCatalog(ingested.catalog, ingested.provenance)` yields entries
  with `supportState: "catalogued"` only — ingestion never configures,
  enables, or produces executable URLs (`url`/`endpoint` absent throughout).
- The entries feed the standard pipeline unchanged:
  `applySupportConfiguration` → `selectRoute` (deterministic pick:
  lowest synthetic estimated rate, then lexicographic route id) →
  `FakeTransport` (`networkUsed: false`).
- A stale ingested snapshot refuses routing (`stale-catalog` /
  `future-catalog` on every candidate, `no-eligible-route`, null transport).

## Hard limits

No live model/provider calls, no credentials, no network (`--fetch` is the
only networked path and is never exercised in tests), no compatibility, cost,
or savings claims. Catalog presence (`catalogued`) is not support,
permission, configuration, conformance, or availability.
