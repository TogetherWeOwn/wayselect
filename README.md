# Wayselect

> **Early development — fixture-only, dry-run only.** No live routing, no live model calls, no credentials, no endpoint discovery. Makes no compatibility, cost, or savings claims. Catalog presence (`catalogued`) is not support, permission, configuration, conformance, or availability.

Wayselect is a small Node 20+ ES module library with a thin local CLI. It turns a newly authored synthetic, models.dev-shaped catalog fixture into an explicit support configuration, applies fail-closed eligibility rules, and returns an inspectable selection explanation. The only transport in this slice is an in-memory fake adapter.

## What Wayselect is / is not

Is:

- A dry-run selector over a synthetic fixture catalog: normalize, configure explicit support states, apply fail-closed eligibility, and explain the deterministic pick.
- A local teaching and review surface — every decision ships its candidate reasons, provenance, and synthetic-rate policy.

Is not:

- A transport gateway: it never routes a request to a live model, never discovers endpoints, and never sends traffic over the network (`FakeTransport` reports `networkUsed: false`).
- A compatibility, cost, or savings oracle: selected rates are synthetic/list-price estimates only, and catalog presence never implies permission, configuration, conformance, or availability.

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
- `npm ci` before `npm test` — the suite uses pinned packages (`ajv`, `ajv-formats` for catalog-entry schema validation; `escape-html` for the preview page). The fixture demo itself (`node bin/wayselect select`) needs no install and runs on the standard library alone.
- No environment variables or credentials for the fixture demo

## Reproducible local demo

Quickstart from a clean checkout:

```sh
git clone https://github.com/TogetherWeOwn/wayselect && cd wayselect
node --version   # 20+
npm ci
npm test
npm run demo
```

Full CLI reference (copy-pasteable `select`/`explain` examples, `--json`, exit codes 0/1/2/3): see `docs/cli.md`.

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

Compares three storefront search-prompt versions over 30 fixed queries
(`evals/search-prompt-regression/queries.json`) against the 3 stub listings
and records top-1 relevance before/mid/after in
`evals/search-prompt-regression/results.md`: v1-baseline (raw substring
pass-through, shipped S2 rule) vs v2-cue-extraction (deterministic
interpret-then-match) vs v3-negation-scope (v2 plus negation scope).
Stdlib only, no network, no credentials; seed 5492
recorded for the shuffle-invariance self-check. Today: before 13/30, mid
24/30, after 30/30 — v2 fixed 11, v3 fixed 6, 0 regressed.

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

## Catalog ingestion from models.dev-shaped JSON

`wayselect catalog import <file|--fetch>` maps provider-keyed,
models.dev-shaped JSON (providers → models with modalities, limits,
tool/structured-output flags, and list prices) onto the normalized catalog
schema and writes a `{ provenance, catalog }` document. Default reads a local
file; `--fetch` is the only networked path, explicit and never exercised in
tests. Every ingested entry lands as support state `catalogued` only —
ingestion never configures, enables, or produces executable URLs.
Unknown/malformed fields are quarantined with reasons; capabilities are never
guessed. Tests use small newly-authored fixtures, never a redistributed
snapshot.

```sh
node bin/wayselect catalog import models.json \
  --source "https://models.dev/api.json" \
  --snapshot-timestamp 2026-09-24T10:00:00.000Z \
  --out catalog.json
```

Provenance: `--source` defaults to the `file://` input path (or the fetch
URL with `--fetch`), `--snapshot-timestamp` defaults to now, and
`--snapshot-hash` defaults to the canonical SHA-256 hash of the ingested
mapping — the same gate `normalizeCatalog` verifies, so a default import
always round-trips. An explicit `--snapshot-hash` that does not match the
ingested body fails closed instead of writing an unverifiable document.
`--json` emits the machine-readable summary (`command`, `networkUsed`,
`entryCount`, `quarantined` with per-entry reasons, `outPath`).

## Library boundaries

- `src/catalog.js` validates a narrow provider-keyed, models.dev-shaped fixture subset and preserves provenance. Unknown fields are rejected at the boundary.
- `src/ingest.js` maps models.dev-shaped JSON onto catalog input with provenance (`ingestModelsDev`); known upstream extras are stripped, unknowns quarantine with reasons.
- `src/support.js` applies explicit support states and configured operation claims without mutating catalog evidence.
- `src/eligibility.js` applies operation, capability, provider, and evidence-age rules. An empty provider allowlist is invalid.
- `src/selection.js` produces a dry-run decision and full candidate explanations.
- `src/transport.js` exposes only `FakeTransport`; executable location fields are rejected.
- `src/canonical.js` provides the canonical-JSON form the provenance hash is computed over.
- `src/gateway.js` exposes the Phase-1 OpenAI chat-completions skeleton as a pure in-process handler (`handleChatCompletionsRequest`): `POST /v1/chat/completions` non-streaming only, `model` auto-route + pinned semantics, the spec error table, FakeTransport-backed with `dryRun:true` and synthetic text labeled synthetic. **Synthetic-only:** every completion in this slice is fake-backed (`networkUsed:false` enforced); no live calls, no credentials, no spend.
- `bin/wayselect` is the thin CLI: `select`/`explain` subcommands plus the opt-in `catalog import` ingestion path (`--fetch` is the only networked path; `--help`, `--version`, exit codes 0/1/2/3; see `docs/cli.md`) with the bare-invocation fixture demo kept for backward compatibility.
- `bin/refresh-catalog-fixtures` stamps fixture provenance and verifies it (`--check`).
- `bin/accept-wayselect-gateway-phase1` is the Phase-1 gateway conformance script (auto-route, pinned-eligible, pinned-ineligible 400, no-eligible-route 400, 401 cases; README synthetic-only check). Offline: in-process handler plus a fetch stub that throws.

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

The gateway surface (`src/gateway.js`, Phase 1) is synthetic-only: completions are FakeTransport-backed (`networkUsed:false` is enforced on every result), carry `dryRun:true` + `synthetic:true`, and can never spend or touch the network. Streaming/SSE, the Anthropic surface, and live transport are later phases.

## Docs index

Acceptance specs and contracts live in `docs/`. Start here:

- [Acceptance spec — capability-aware dry-run select](docs/acceptance-spec-capability-select.md) — next-feature acceptance for capability-aware selection (v1).
- [CLI `--json` machine contract](docs/cli-json-contract.md) — versioned machine interface for `select --json` / `explain --json`.
- [`wayselect` CLI reference](docs/cli.md) — copy-pasteable `select`/`explain` examples, `--json`, exit codes.
- [Dependency-update policy](docs/dependency-update-policy.md) — how dependencies are updated and who owns it.
- [Eligibility reason glossary](docs/eligibility-reasons.md) — operator lookup for every eligibility reason code.
- [models.dev ingestion dry-run contract](docs/models-dev-ingestion-dryrun-contract.md) — pinned interface for the ingestion adapter.
- [Local pre-push check](docs/pre-push-check.md) — run the same gates CI runs before you push.
- [Buyer activation spec](docs/wayselect-buyer-activation.md) — search → compare → shortlist first-value path.
- [Buyer listing spec](docs/wayselect-buyer-listing.md) — listing fields + purchase acceptance (v2).
- [Eligibility-explain acceptance](docs/wayselect-eligibility-acceptance.md) — fail-closed eligibility paths on the CLI.
- [First-run onboarding spec](docs/wayselect-onboarding-spec.md) — empty states, picker copy, eligibility-explain entry point.
- [Seller payout-status acceptance](docs/wayselect-payout-acceptance.md) — accepted offer → pending → released.
- [Preview security checklist (S42-style)](docs/wayselect-preview-s42-checklist.md) — S42-style security review of the preview storefront.
- [Preview security checklist](docs/wayselect-preview-security-checklist.md) — security review of the preview storefront.
- [Catalog search/filter acceptance](docs/wayselect-search-filter-acceptance.md) — executable contract for the search/filter slice.
- [Seller acceptance](docs/wayselect-seller-acceptance.md) — list → offer → accept slice.
- [Seller payout-eligibility checklist](docs/wayselect-seller-payout-eligibility.md) — payout-eligibility rules (part 4).
- [Snapshot retention policy](docs/snapshot-retention.md) — keep-last-10 + 30-day prune rule and `bin/wayselect-snapshot-prune` usage.
- [Web acceptance](docs/wayselect-web-acceptance.md) — listing-detail + search/filter web slices.
- [Slow-network knob](docs/wayselect-slow-network-knob.md) — `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` operator contract (fragment only, never the shell).

## Contributing

Full contributor guide (setup, ground rules, branch/PR, gates, review and
merge): [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

- Tests stay offline: the suite runs `node --test` with pinned packages only; the `transport` test fails if `fetch` is called, server tests bind an ephemeral port and talk to it over `localhost`/`127.0.0.1`, and the probe tests run the CLI against saved local input (`--fetch`, the only networked path, is never exercised in tests). Do not add tests that reach the live network.
- Fixture policy: fixtures under `fixtures/` are synthetic and checked in. Add or edit them as data files; refresh stamped provenance through `bin/refresh-catalog-fixtures`, never by hand-editing. Keep unknown fields rejected at the `src/catalog.js` boundary and never guess missing capability data.
- Node 20+ ESM; keep `bin/wayselect` thin and `src/` boundaries intact. Run `npm run accept:fixture-refresh` + `npm run check:drift` after each refresh. No new runtime dependencies without a CTO note.
- Keep README claims accurate to merged behavior only — no compatibility, cost, or savings language.

License: not yet chosen.
