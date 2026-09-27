# Wayselect

> **Early development: fixture-only and dry-run only.** Wayselect does not call models, store credentials, discover endpoints, or claim production compatibility, savings, or optimal routing.

Wayselect is a small Node 20+ ES module library with a thin local CLI. It turns a newly authored synthetic, models.dev-shaped catalog fixture into an explicit support configuration, applies fail-closed eligibility rules, and returns an inspectable selection explanation. The only transport in this slice is an in-memory fake adapter.

## What this slice proves

- Catalog input is normalized at one boundary and carries `source`, snapshot timestamp, and SHA-256-shaped provenance.
- Catalog presence stays `catalogued`; it does not imply permission, configuration, conformance, or availability.
- Executable candidates must have an explicit support state, configured operations, fresh evidence, and an explicit provider allowlist.
- Missing capability data, unsupported operations, stale evidence, and disallowed providers fail closed with stable reason codes.
- Selection is deterministic: lowest synthetic/list-price estimate first, then lexicographic route ID for ties.
- Catalog records and fake-transport routes cannot carry executable URL fields.
- The fixture demo runs with Node standard library only and performs no network access.

## Support states

| State | Meaning in this slice | Eligible? |
| --- | --- | --- |
| `catalogued` | Present in a normalized catalog only | No |
| `configured` | Explicitly configured for named operations | Yes, if every other rule passes |
| `conformance-tested` | Explicitly configured with recorded synthetic conformance evidence | Yes, if every other rule passes |
| `unavailable` | Known but currently unavailable | No |
| `unsupported` | Explicitly unsupported | No |

A support state is not a provider credential or permission grant. Evidence can also expire; stale or missing evidence excludes an otherwise configured candidate.

## Requirements

- Node.js 20 or newer
- No package installation
- No environment variables or credentials

## Reproducible local demo

```sh
node --version
npm test
npm run demo
```

The demo (`wayselect select`) reads only:

- `fixtures/catalog.synthetic.json`
- `fixtures/configuration.synthetic.json`
- `fixtures/request.synthetic.json`

It prints:

1. the deterministic selected route or `no eligible route`, labelled dry-run;
2. the ranked candidates with eligibility or exclusion reasons;
3. fixture provenance.

Use `wayselect select --json` or `wayselect explain` for the
subcommand UX with human output, machine-readable shape, and exit codes
(0 selected, 1 invalid input, 2 usage error, 3 no eligible route).
See `docs/cli.md` for copy-pasteable examples.

Use alternate fixture files without adding code or network access:

```sh
node bin/wayselect select \
  --catalog fixtures/catalog.synthetic.json \
  --configuration fixtures/configuration.synthetic.json \
  --request fixtures/request.synthetic.json
```

## Staging catalog snapshots and diffs

Staging-only automation with no network access and no production writes.
Snapshots reuse the `normalizeCatalog` boundary, record a recomputed
SHA-256 content hash, and report provenance gaps (unverified declared
hash, stale/future snapshot, missing capabilities, missing rates,
no catalogued operations). Non-`synthetic://` sources are refused.

```sh
node bin/wayselect-snapshot \
  --now 2026-09-24T12:00:00.000Z \
  --max-catalog-age-hours 24 \
  --out snapshots
node bin/wayselect-snapshot \
  --now 2026-09-24T12:05:00.000Z \
  --max-catalog-age-hours 24 \
  --out snapshots \
  --previous snapshots/snapshot-20260924T120000000Z-c6cdb62e.json
```

The second run writes a second snapshot plus a Markdown diff report
(added/removed/changed routes, gap deltas). A stale or future-dated
catalog fails closed instead of writing a snapshot. See
`snapshots/diff-report-consecutive-green.md` and
`snapshots/sample-diff-with-changes.md` for sample evidence.

## Fixture refresh

The catalog fixture carries provenance (`source`, `snapshotTimestamp`,
`snapshotHash`) so QA fixtures never go stale behind the models.dev ingestion.
Refresh through the script, never by hand-editing:

```sh
node bin/refresh-catalog-fixtures --timestamp 2026-09-26T14:00:00.000Z
node bin/refresh-catalog-fixtures --check --now 2026-09-26T15:00:00.000Z
npm run refresh:check
```

Refresh advances the whole set by one uniform clock delta: the catalog's
provenance stamp, every support-evidence `observedAt`, and the request's
`evaluationTime` all move together, preserving relative offsets. The
intentionally stale `legacy/old-chat` evidence stays stale so the
stale-evidence path keeps exercising; the suite's evaluation clock is derived
from the live snapshot (`support/helpers.js`), so it stays green across
refreshes without edits.

`snapshotHash` is a deterministic SHA-256 over the canonical (recursively
key-sorted) catalog body. Re-running with the same `--timestamp` is a
byte-identical no-op (`changed:false`), so a scheduler can skip empty commits.
QA acceptance: re-run refresh and the fixtures match the recorded hash —
`--check` verifies the hash and the freshness window (`--max-age-hours`,
default 24) and exits non-zero on mismatch, staleness, or malformed input.
Only stamped values change in the files; formatting elsewhere is preserved.
Rewinding the snapshot clock or introducing unknown fields fails closed and
leaves every file untouched.

Suggested daily schedule (writes only when the timestamp advances):

```sh
node bin/refresh-catalog-fixtures --timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm run refresh:check && npm test
```

## Provenance-drift detector probe (TOG-5542)

Independent leaf beside the [TOG-5116](/TOG/issues/TOG-5116) harness: where
`bin/accept-fixture-refresh` re-runs the refresh on scratch copies, this
probe is read-only and checks the committed state — it never writes
fixtures, never refreshes, never runs the suite. Three fail-loud checks,
exit non-zero on any drift (an alert):

```sh
npm run check:drift
node bin/check-provenance-drift --now 2026-09-26T16:00:00.000Z --out drift-report.json
```

- **D1 self-hash:** the live catalog body recomputes to its own recorded
  `snapshotHash` (catches hand-edits and bad merges; the library boundary
  also rejects unknown fields fail-closed).
- **D2 evidence pin:** the same hash equals the `provenanceHash` in
  `fixture-refresh-evidence.json` from the last green harness run, and that
  run's verdict is `PASS` (catches body changes made outside a re-pinned
  refresh).
- **D3 freshness:** the recorded snapshot is within the freshness window
  (catches a refresh scheduler that went quiet).

Suggested pairing after each refresh: `npm run accept:fixture-refresh`
re-pins the evidence, then `npm run check:drift` confirms the committed
state — the probe stays green across 3 consecutive refreshes.

## Search-prompt regression eval (TOG-5492)

```sh
npm run eval:search-prompts
```

Compares two storefront search-prompt versions over 20 fixed queries
(`evals/search-prompt-regression/queries.json`) against the 3 stub listings
and records top-1 relevance before/after in
`evals/search-prompt-regression/results.md`: v1-baseline (raw substring
pass-through, shipped S2 rule) vs v2-cue-extraction (deterministic
interpret-then-match). Stdlib only, no network, no credentials; seed 5492
recorded for the shuffle-invariance self-check. Today: before 12/20, after
20/20 — 8 fixed, 0 regressed.

## Catalog search-index refresh

Fixture-only automation with no network access and no production writes.
`src/searchIndex.js` derives a frozen, searchable view over the fixture
catalog through the same `normalizeCatalog` boundary the CLI uses, so the
index can never describe routes the catalog boundary would reject. Refresh
is a queued job (`createRefreshQueue`: FIFO, identical pending requests
dedup instead of stacking) with an idempotent reload proof
(`reloadSearchIndex` reports `changed:false` on identical input).
Non-`synthetic://` sources are refused; stale or future-dated catalogs fail
closed instead of writing an index.

```sh
npm run check:search-index
node bin/wayselect-search-index-refresh --check --max-catalog-age-hours 24
node bin/wayselect-search-index-refresh --max-catalog-age-hours 24 --out search-index
```

The probe (`--check`, five checks R1–R5) rebuilds twice and reloads: done
criteria for TOG-5460 is the probe passing twice consecutively with the same
content hash. Same-input refreshes over `--previous` report
`changedVsPrevious:false`. The evaluation clock follows the same
snapshot-derived pattern as the suite (`support/helpers.js`
`evaluationNow()`): when no `--now` is given, the CLI evaluates two hours
after the live fixture `snapshotTimestamp`, so the probe stays green across
fixture refreshes without edits.

## Library boundaries

- `src/catalog.js` validates a narrow provider-keyed, models.dev-shaped fixture subset and preserves provenance. Unknown fields are rejected at the boundary.
- `src/support.js` applies explicit support states and configured operation claims without mutating catalog evidence.
- `src/eligibility.js` applies operation, capability, provider, and evidence-age rules. An empty provider allowlist is invalid.
- `src/selection.js` produces a dry-run decision and full candidate explanations.
- `src/transport.js` exposes only `FakeTransport`; executable location fields are rejected.
- `src/canonical.js` provides the canonical-JSON form the provenance hash is computed over.
- `bin/wayselect` is the thin CLI: `select`/`explain` subcommands (`--help`, `--version`, exit codes 0/1/2/3; see `docs/cli.md`) with the bare-invocation fixture demo kept for backward compatibility.
- `bin/refresh-catalog-fixtures` stamps fixture provenance and verifies it (`--check`).

The normalized capability names are `attachment`, `reasoning`, `toolUse`, `structuredOutput`, `imageInput`, `textInput`, and `textOutput`. A required name not present in normalized data is reported as `missing-capability:<name>` and is never guessed.

A selection request may also carry an optional `requirements` object with typed
constraints, evaluated after the legacy boolean checks in fixed field order so
the dry-run explanation is deterministic:

- `inputModalities: ["text", "image"]` / `outputModalities: ["text"]` — every
  listed modality must appear in the candidate's normalized `modalities`.
  Otherwise `missing-modality:input:<value>` (or `output:`).
- `minContextWindow: 8000` — the candidate's `limits.contextWindow` must meet
  it. Unknown limits report `missing-capability:contextWindow`; a short limit
  reports `insufficient-context-window`.
- `maxOutputTokens: 2000` — same shape against `limits.maxOutputTokens`
  (`missing-capability:maxOutputTokens` / `insufficient-max-output-tokens`).
- `toolCalling: true`, `structuredOutput: true`, `reasoning: true` — checked
  against the normalized `toolUse`, `structuredOutput`, and `reasoning` flags
  with the existing `missing-capability:` / `unsupported-capability:`
  vocabulary. `false` means no constraint.

Missing or unknown data always fails closed with an explicit reason; reasons
never repeat (overlapping legacy and typed checks dedupe). Absent
`requirements` leaves legacy behavior untouched. The catalog fixture accepts
optional per-model `context_window` / `max_output_tokens` counts (absent means
unknown, malformed means rejected); normalized entries expose frozen
`modalities` and `limits` alongside `capabilities`.

## Explicit non-goals

This slice does not include live provider calls, endpoint discovery, credentials, HTTP servers, paid inference, real usage or billing data, third-party catalog redistribution, production deployment, universal compatibility, or a savings claim. Future transport or live-conformance work requires separate provenance, security, access, and review decisions.
