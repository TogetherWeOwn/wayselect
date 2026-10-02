# CLI surface vs modules audit — `searchIndex.js` / `snapshot.js` / `provenanceAudit.js` (TOG-6372)

Gap G11 (round-3 gap list, [TOG-6346](/TOG/issues/TOG-6346)): the three
staging/provenance modules existed but module-to-CLI coverage was unrecorded.
This doc records it. Reverified against `main` at `3814fbd` on 2026-10-01 by
grepping every export name against `bin/` (caller map), `src/index.js`
(re-exports), `test/` (pins), `package.json` (scripts), and
`.github/workflows/ci.yml` (gates).

Scope: the three modules only. `src/catalogDiff.js`
(`diffSnapshots`, `formatDiffReport`, `compareEntries`) is adjacent —
`bin/wayselect-snapshot` imports the first two — but it is not one of the
three audited modules and is noted inline, not tabulated.

## `src/searchIndex.js` — 8 exports

Source constants: `SEARCH_INDEX_TOOL` is `"wayselect-search-index"`,
`SEARCH_INDEX_MODE` is `"fixture-only"`, `DEFAULT_SEARCH_INDEX_SOURCE_PREFIX`
is `"synthetic://"`.

| Export | Wired CLI caller | How exercised | Test pin |
|---|---|---|---|
| `buildSearchIndex` | `bin/benchmark-large-catalog` (direct import) — notably NOT `bin/wayselect-search-index-refresh` | benchmark times it over the large fixture; the refresh CLI builds through the queue instead | `test/search-index.test.js`, `test/large-catalog-benchmark.test.js` |
| `reloadSearchIndex` | `bin/wayselect-search-index-refresh` (direct import) | queue drain + `--previous` compare + idempotent-reload proof before write | `test/search-index.test.js` (CLI `--check` 5/5 twice) |
| `createRefreshQueue` | `bin/wayselect-search-index-refresh` (direct import) | one enqueue + drain per run; identical pending requests dedup | `test/search-index.test.js` |
| `probeSearchIndexRefresh` | `bin/wayselect-search-index-refresh` (direct import, `--check` path) + `bin/benchmark-large-catalog` | `--check` prints R1–R5 and exits non-zero unless all pass | `test/search-index.test.js` |
| `SearchIndexError` | no `bin/` caller (thrown by the library; CLI surfaces it via `formatCliFailure`) | unit-throw asserts | `test/search-index.test.js` |
| `SEARCH_INDEX_TOOL` | no `bin/` caller (no CLI imports it) | behavior-pinned: unit test asserts `index.tool === "wayselect-search-index"` | `test/search-index.test.js` |
| `SEARCH_INDEX_MODE` | no `bin/` caller — `bin/wayselect-search-index-refresh` prints the literal `"fixture-only"` instead of importing it | behavior-pinned: unit test asserts `index.mode === "fixture-only"`; CLI stdout asserts `"fixture-only"` | `test/search-index.test.js` |
| `DEFAULT_SEARCH_INDEX_SOURCE_PREFIX` | no `bin/` caller | default-arg path covered through `buildSearchIndex` unit tests | `test/search-index.test.js` |

## `src/snapshot.js` — 7 exports

Source constants: `DEFAULT_STAGING_SOURCE_PREFIX` is `"synthetic://"`;
`KNOWN_CAPABILITY_NAMES` is `["attachment", "reasoning", "toolUse", "structuredOutput"]`.

| Export | Wired CLI caller | How exercised | Test pin |
|---|---|---|---|
| `buildSnapshot` | `bin/wayselect-snapshot` (direct import) + `bin/benchmark-large-catalog` + `bin/smoke-wayselect-ingestion` (via `src/index.js` re-export) | snapshot write path; `--previous`/`--report`/`--fail-on-gaps` build on its output | `test/snapshot.test.js`, `test/snapshot-determinism.test.js`, `test/cli-errors.test.js`, `test/stale-feed-fail-closed.test.js` |
| `computeContentHash` | no `bin/` caller — library-internal (called by `src/searchIndex.js` and `src/provenanceAudit.js`) | unit-tested directly (order-insensitive, tamper-sensitive) | `test/snapshot.test.js` |
| `findEntryGaps` | no `bin/` caller — called inside `buildSnapshot`; `bin/wayselect-snapshot` reads `snapshot.gaps` / `gapCount`, never the function | unit-tested directly | `test/snapshot.test.js` |
| `snapshotIsClean` | no `bin/` caller — re-exported via `src/index.js` only | unit-tested directly (throws on invalid input, true on zero gaps, false on nonempty gaps) | `test/snapshot.test.js` |
| `SnapshotError` | no `bin/` caller (thrown by the library; CLI surfaces it via `formatCliFailure`, including the exact-bytes non-staging-source message) | unit-throw asserts + CLI error-copy asserts | `test/snapshot.test.js`, `test/cli-errors.test.js` |
| `DEFAULT_STAGING_SOURCE_PREFIX` | no `bin/` caller — `bin/wayselect-snapshot` defines a local `STAGING_SOURCE_PREFIX = "synthetic://"` literal instead of importing it | duplication recorded here, not a bug; behavior pinned by the non-staging-source refusal message | `test/cli-errors.test.js` |
| `KNOWN_CAPABILITY_NAMES` | no `bin/` caller — consumed inside `findEntryGaps` | behavior-pinned through gap assertions | `test/snapshot.test.js` |

## `src/provenanceAudit.js` — 6 exports

Source constants: `DEFAULT_BACKFILL_MAX_AGE_MS` is 24h;
`EXPECTED_BACKFILL_TOOL` is `"wayselect-snapshot"`;
`EXPECTED_BACKFILL_MODE` is `"staging-only"`;
`EXPECTED_BACKFILL_SOURCE_PREFIX` is `"synthetic://"`.

| Export | Wired CLI caller | How exercised | Test pin |
|---|---|---|---|
| `auditIngestionSnapshot` | `bin/check-ingestion-provenance` (direct import) | per-backfill PASS/FAIL over `snapshots/` or explicit files; `--now` / `--max-catalog-age-hours` forwarded as audit options | `test/provenance-backfill.test.js` (committed backfills green, stale/tampered red) |
| `DEFAULT_BACKFILL_MAX_AGE_MS` | `bin/check-ingestion-provenance` (direct import; default when `--max-catalog-age-hours` is absent) | default-window path | `test/provenance-backfill.test.js` |
| `ProvenanceAuditError` | no `bin/` caller (thrown by the library) | unit-throw asserts | `test/provenance-backfill.test.js` |
| `EXPECTED_BACKFILL_TOOL` | no `bin/` caller — asserted inside `auditIngestionSnapshot`; the CLI prints the literal `"staging-only"` in its summary JSON instead of importing the constants | behavior-pinned through green-backfill asserts | `test/provenance-backfill.test.js` |
| `EXPECTED_BACKFILL_MODE` | no `bin/` caller (same literal-duplication note as above) | behavior-pinned through green-backfill asserts | `test/provenance-backfill.test.js` |
| `EXPECTED_BACKFILL_SOURCE_PREFIX` | no `bin/` caller (same literal-duplication note as above) | behavior-pinned through green-backfill asserts | `test/provenance-backfill.test.js` |

## Cross-cutting findings

1. **The main CLI imports none of the three modules.** `bin/wayselect`
   imports only the select/explain/ingest surface from `src/index.js` plus
   `src/cliErrors.js`. Its `--snapshot-timestamp` / `--snapshot-hash` flags
   feed ingestion provenance, not these modules. The three modules are
   exercised exclusively through standalone helper binaries, not
   subcommands.
2. **Library-only exports are intentional, not gaps.**
   `snapshotIsClean`, `findEntryGaps`, `computeContentHash`
   (`src/snapshot.js`) and `compareEntries` (`src/catalogDiff.js`, adjacent)
   have no `bin/` caller; they are consumed inside `buildSnapshot` /
   `diffSnapshots` / `auditIngestionSnapshot` or by smoke/benchmark harnesses
   via `src/index.js`. All are unit-tested.
3. **Constant duplication is recorded, not fixed here.**
   `bin/wayselect-snapshot` duplicates `DEFAULT_STAGING_SOURCE_PREFIX` as a
   local; the refresh and provenance CLIs print `"fixture-only"` /
   `"staging-only"` literals instead of importing `SEARCH_INDEX_MODE` /
   `EXPECTED_BACKFILL_MODE`. Behavior is pinned by exact-bytes message tests
   and tool/mode asserts, so the duplication is safe but must stay in sync —
   the guard test below fails if a new export is added without a doc row.
4. **`buildSearchIndex` is the queue-bypass exception.** The refresh CLI never
   imports it; it builds through `createRefreshQueue` + `reloadSearchIndex`.
   Direct `buildSearchIndex` CLI coverage comes only from
   `bin/benchmark-large-catalog`.
5. **`docs/cli.md` covers only `select` / `explain` / `catalog import`.**
   The helper CLIs are documented in `README.md` sections (snapshots/diffs,
   drift probe, search-index refresh) and `docs/snapshot-retention.md`, not
   in `docs/cli.md`. No change made here; this doc is the coverage record.

## Operator map (scripts + CI)

- `npm run snapshot` → `bin/wayselect-snapshot`; `npm run prune:snapshots`
  → `bin/wayselect-snapshot-prune` (covers `src/snapshotPrune.js`, out of
  scope); `npm run check:provenance` → `bin/check-ingestion-provenance`;
  `npm run refresh:search-index` / `npm run check:search-index` →
  `bin/wayselect-search-index-refresh`; `npm run bench:large-catalog` →
  `bin/benchmark-large-catalog`; `npm run smoke` →
  `bin/smoke-wayselect-ingestion` (exercises `buildSnapshot` via
  `src/index.js`).
- CI (`.github/workflows/ci.yml`) runs `npm test` (whole suite, including
  the CLI-exec tests listed above) plus `npm run smoke`, plus a dedicated
  `search-index-probe` job (`npm run check:search-index` — the R1–R5
  fixture-only refresh probe). The `large-catalog-bench` job also runs
  `bin/benchmark-large-catalog` directly and uploads timing JSON; its
  benchmark step is non-blocking (`continue-on-error: true`). Remaining
  helper coverage rides the suite.

## Maintenance

`test/cli-module-coverage.test.js` enforces this doc: it extracts every
`export const|function|class` name from the three modules and fails if any
lacks its own `| \`name\` |` table row here, if any backticked `bin/` path in this
doc does not exist, or if this doc is missing from the `README.md` docs
index. Add the row when you add the export.
