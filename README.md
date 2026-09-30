# Wayselect

[![CI](https://github.com/TogetherWeOwn/wayselect/actions/workflows/ci.yml/badge.svg)](https://github.com/TogetherWeOwn/wayselect/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Early development — fixture-only, dry-run only.** No live routing, no live model calls, no live provider credentials, no endpoint discovery. Makes no compatibility, cost, or savings claims. Catalog presence (`catalogued`) is not support, permission, configuration, conformance, or availability. (The Phase-1 gateway handler verifies an operator-held bearer key supplied at call time; see Library boundaries.)

Wayselect is a small Node 20+ ES module library with a local CLI. It turns a newly authored synthetic, models.dev-shaped catalog fixture into an explicit support configuration, applies fail-closed eligibility rules, and returns an inspectable selection explanation. The selection transport in this slice is an in-memory fake adapter only (`FakeTransport`); the only outbound network paths anywhere are the explicit opt-in `--fetch` flags for catalog ingestion and the models.dev freshness probe.

## What Wayselect is / is not

Is:

- A dry-run selector over a synthetic fixture catalog: normalize, configure explicit support states, apply fail-closed eligibility, and explain the deterministic pick.
- A local teaching and review surface — every decision ships its candidate reasons, provenance, and synthetic-rate policy.

Is not:

- A transport gateway: it never routes a selection request to a live model, never discovers endpoints, and the selection path never sends traffic over the network (`FakeTransport` reports `networkUsed: false`). The only outbound network paths are the explicit opt-in `--fetch` flags for catalog ingestion and the models.dev freshness probe (never exercised as live fetches in tests).
- A compatibility, cost, or savings oracle: selected rates are synthetic/list-price estimates only, and catalog presence never implies permission, configuration, conformance, or availability.

## What this slice proves

- Catalog input is normalized at one boundary and carries `source`, snapshot timestamp, and SHA-256-shaped provenance.
- Catalog presence stays `catalogued`; it does not imply permission, configuration, conformance, or availability.
- Executable candidates must have an explicit support state, configured operations, fresh evidence, and an explicit provider allowlist.
- Missing capability data, unsupported operations, stale evidence, and disallowed providers fail closed with stable reason codes.
- Selection is deterministic: lowest synthetic/list-price estimate first, then lexicographic route ID for ties.
- Catalog records and fake-transport routes cannot carry executable location fields (`url`, `endpoint`, `baseUrl`, `apiUrl` are rejected at the boundary).
- The fixture demo performs no network access (the demo path never calls `fetch`; `FakeTransport` only). It still needs `npm ci` first — only `bin/wayselect-snapshot`, `bin/wayselect-search-index-refresh`, `bin/wayselect-snapshot-prune`, and `bin/eval-wayselect-search-prompts` run on the standard library alone.

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
- `npm ci` before `npm test` — the suite uses pinned packages (`ajv`, `ajv-formats` for CLI `--json` machine-shape and catalog-entry schema validation; `escape-html` for the preview page). The fixture demo itself (`node bin/wayselect select`) needs that install too — only `bin/wayselect-snapshot`, `bin/wayselect-search-index-refresh`, `bin/wayselect-snapshot-prune`, and `bin/eval-wayselect-search-prompts` run on the standard library alone.
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

End-to-end example (capability-aware select, exit 0 — typed requirements
from flags, exclusions named per candidate):

```sh
node bin/wayselect select --operation chat --allow northstar,orbit \
  --input-modalities text --output-modalities text --require-tools \
  --evaluation-time 2026-09-30T12:28:11.003Z
```

```text
dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use
Selected route: northstar/alpha-chat
Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id
Rates are synthetic/list-price estimates only; not actual cost or savings.

Ranked candidates (2 eligible, 4 excluded):
  1. northstar/alpha-chat — eligible, est. 3 / million tokens
  2. orbit/orbit-chat — eligible, est. 3 / million tokens
  3. legacy/old-chat — excluded (provider-not-allowed, stale-evidence)
  4. northstar/image-lite — excluded (operation-not-catalogued, operation-not-configured, missing-modality:input:text, unsupported-capability:toolUse)
  5. northstar/unknown-tools — excluded (missing-capability:toolUse)
  6. orbit/retired-chat — excluded (support-state:unsupported, operation-not-configured)

Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-30T10:28:11.003Z
```

(Pin `--evaluation-time`: without it the CLI evaluates at the wall clock,
which the catalog freshness gate correctly refuses as stale once the
fixtures age past 24h — see `docs/cli.md`.)

Use alternate fixture files without adding code or network access:

```sh
node bin/wayselect select \
  --catalog fixtures/catalog.synthetic.json \
  --configuration fixtures/configuration.synthetic.json \
  --request fixtures/request.synthetic.json
```

## Deploying the preview server (staging only)

> **Runbook only — no production activation.** The image and deploy path
> below are staging/preview-only. Production deploys stay reviewer-gated
> and inactive (see `docs/deployment-runbook.md` §6).

Build and run the preview-server image locally with Docker:

```sh
docker build -t wayselect:local .
docker run --rm -p 3000:3000 \
  -e WAYSELECT_PREVIEW=1 \
  wayselect:local
```

Then verify with the repo's own health probe:

```sh
node bin/check-preview-health --base-url http://localhost:3000
```

Exit 0 = every check passed (skips allowed); exit 1 = failure; exit 2 =
usage error. The probe asserts the listing index, one detail page, the
unknown-listing 404, the purchase-stub 403 guard, and catalog-index
freshness.

Three facts that matter in this slice:

- The server reads **three** variables only — `PORT` (default `3000`,
  integer 1–65535), `HOST` (default `127.0.0.1`; the image sets
  `0.0.0.0`), `WAYSELECT_PREVIEW` (truthy `1`/`true`/`yes`/`on`
  enables the `/listings` routes). No secrets, no database URLs.
- Merging to `main` deploys staging via a host-mediated trigger
  (Coolify rebuilds from the host mirror; the CI job owns the Deployment
  record, target gate, settle poll, and smoke — runbook §4) after `test` +
  `ingestion-smoke` pass; production is operator-initiated only behind a
  required-reviewer gate and stays gated until live activation is
  approved.
- Rollback is redeploying the previous immutable image tag, then
  re-running the probe (the purchase-stub 403 guard must pass — it
  proves the rolled-back build still cannot write).

Full procedure (build pins, env contract, rollback steps, explicit
non-goals): [deployment runbook](docs/deployment-runbook.md).

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
node bin/refresh-catalog-fixtures --timestamp 2026-09-30T10:28:11.003Z
node bin/refresh-catalog-fixtures --check --now 2026-09-30T12:28:11.003Z
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

Scheduled freshness probe (`.github/workflows/fixture-refresh-check.yml`,
TOG-5745): a daily 07:23 UTC job runs the read-only `npm run refresh:check`
and, on failure, opens a `fixture-staleness` issue (deduplicated against
already-open ones) with the remediation commands. The job writes nothing,
commits nothing, and needs no credentials beyond the default `GITHUB_TOKEN`
for issue filing. Manual fallback, same commands the issue body carries:

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
node bin/check-provenance-drift --now 2026-09-30T12:28:11.003Z --out drift-report.json
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
Seed, rerun steps, and expected determinism:
[search-prompt eval seed-rerun contract](docs/search-prompt-eval-seed-rerun.md).

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

The probe (`--check`, five checks R1–R5) builds, rebuilds, and reloads: done
criteria for TOG-5460 is the CLI probe passing twice consecutively with the same
content hash. Same-input refreshes over `--previous` report
`changedVsPrevious:false`. `--previous` is only supported when writing a
refresh: combining it with `--check` fails with exit 1 and a usage error on
stderr, without running the probe or writing an index. Omit `--check` to
validate and compare a previous index. The evaluation clock follows the same
snapshot-derived pattern as the suite (`support/helpers.js`
`evaluationNow()`): when no `--now` is given, the CLI evaluates two hours
after the live fixture `snapshotTimestamp`, so the probe stays green across
fixture refreshes without edits.

## Catalog ingestion from models.dev-shaped JSON

`wayselect catalog import <file|--fetch>` maps provider-keyed,
models.dev-shaped JSON (providers → models with modalities, limits,
tool/structured-output flags, and list prices) onto the normalized catalog
schema and writes a `{ provenance, catalog }` document. Default reads a local
file; `--fetch` is the only networked path for that CLI, explicit and reached
in tests only for flag-conflict usage errors (no live fetch). Every ingested
entry lands as support state `catalogued` only —
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
`--json` emits the machine-readable summary (`command`, `dryRun`, `networkUsed`,
`source`, `snapshotTimestamp`, `snapshotHash`, `rawHash`, `providerCount`,
`entryCount`, `quarantined` with per-entry reasons, `outPath`).

## Library boundaries

- `src/catalog.js` validates a narrow provider-keyed, models.dev-shaped fixture subset and preserves provenance. Unknown fields are rejected at the boundary.
- `src/ingest.js` maps models.dev-shaped JSON onto catalog input with provenance (`ingestModelsDev`); known upstream extras are stripped, unknowns quarantine with reasons.
- `src/support.js` applies explicit support states and configured operation claims without mutating catalog evidence.
- `src/eligibility.js` applies operation, capability, provider, and evidence-age rules. An empty provider allowlist is invalid.
- `src/selection.js` produces a dry-run decision and full candidate explanations.
- `src/transport.js` exposes only `FakeTransport`; executable location fields are rejected.
- `src/canonical.js` provides the shared stable-stringify helper (re-exported through `src/catalog.js`/`src/index.js` and used by the refresh and ingest hash paths). The catalog snapshot hash (`computeCatalogSnapshotHash`) and the search-index content hash (`computeContentHash`) use local key-sorted canonical forms with the same semantics.
- `src/gateway.js` exposes the gateway handlers as pure in-process functions (`handleChatCompletionsRequest`, `handleMessagesRequest`) with no HTTP binding of their own: the OpenAI-shaped `POST /v1/chat/completions` contract, the Anthropic-shaped `POST /v1/messages` contract (required `max_tokens`, text blocks plus an optional `system` prompt), shared `model` auto-route + pinned semantics, the per-surface spec error tables, and SSE streaming on both surfaces (OpenAI `data: {chunk}` + `data: [DONE]`; Anthropic `message_start` … `message_stop`) rendered from one normalized delta stream with upstream retry only before the first byte. `tools` + `stream:true` fails closed with 400 on both surfaces. FakeTransport-backed with `dryRun:true` and synthetic text labeled synthetic. **Synthetic-only:** every completion in this slice is fake-backed (`networkUsed:false` enforced on every result); no live calls, no live provider credentials, no spend. Requests carry an operator-held bearer key that the handlers verify at call time (missing/wrong → 401).
- `bin/wayselect` is the CLI: `select`/`explain` subcommands plus the opt-in `catalog import` ingestion path (`--fetch` is that CLI's only networked path; `--help`, `--version`, exit codes 0/1/2/3; see `docs/cli.md`) with the bare-invocation fixture demo kept for backward compatibility.
- `bin/refresh-catalog-fixtures` stamps fixture provenance and verifies it (`--check`).
- `bin/accept-wayselect-gateway-phase1` is the gateway conformance script (auto-route, pinned-eligible, pinned-ineligible 400, no-eligible-route 400, 401 cases, `stream:true` SSE check; README synthetic-only check). Offline: in-process handlers plus a fetch stub that throws. Full Phase-2 byte-shape coverage (Anthropic surface, both SSE shapes, `tools`+`stream` 400s, killed-upstream first-byte behavior) lives in `test/gateway-phase2.test.js`.

The normalized capability names are `attachment`, `reasoning`, `toolUse`, `structuredOutput`, `imageInput`, `textInput`, and `textOutput`. A required name not present in normalized data is reported as `missing-capability:<name>` and is never guessed.

A selection request may also carry an optional `requirements` object with typed
constraints, evaluated in fixed order — legacy checks first (support state,
provider, operations, `requiredCapabilities`), then typed `requirements` in
fixed field order, then evidence for eligible states — so the dry-run
explanation is deterministic:

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

This slice does not include live provider calls, endpoint discovery, live provider credentials, paid inference, real usage or billing data, third-party catalog redistribution, production deployment, universal compatibility, or a savings claim. The only HTTP surface is the local preview server (`node web/server.js`, gated by `WAYSELECT_PREVIEW`); the only credential check is the operator-held gateway bearer key the gateway handlers verify at call time. Future transport or live-conformance work requires separate provenance, security, access, and review decisions.

The gateway surface (`src/gateway.js`, Phases 1–2) is synthetic-only: completions and streams are FakeTransport-backed (`networkUsed:false` is enforced on every result), carry `dryRun:true` + `synthetic:true`, and can never spend or touch the network. Streams render from one normalized delta stream with upstream retry only before the first byte. Live transport is a later phase.

## Docs index

Acceptance specs and contracts live in `docs/`. Start here:

- [Acceptance spec — capability-aware dry-run select](docs/acceptance-spec-capability-select.md) — next-feature acceptance for capability-aware selection (v1).
- [CLI `--json` machine contract](docs/cli-json-contract.md) — versioned machine interface for `select --json` / `explain --json`.
- [Preview server route table](docs/preview-server.openapi.json) — machine-readable OpenAPI route table for `web/server.js` (every route, method, params, status codes).
- [`wayselect` CLI reference](docs/cli.md) — copy-pasteable `select`/`explain` examples, `--json`, exit codes.
- [`bin/` operator catalog](docs/bin-operator-catalog.md) — one line per script: purpose, when to run, key flags.
- [Dependency-update policy](docs/dependency-update-policy.md) — how dependencies are updated and who owns it.
- [Export-control note](docs/export-control.md) — public-availability basis, no encryption functionality, no controlled technology.
- [Eligibility reason glossary](docs/eligibility-reasons.md) — operator lookup for every eligibility reason code.
- [models.dev ingestion dry-run contract](docs/models-dev-ingestion-dryrun-contract.md) — pinned interface for the ingestion adapter.
- [models.dev freshness-probe offline contract](docs/models-dev-freshness-probe-offline-contract.md) — what `bin/check-models-dev-freshness` reads, never touches, and how to verify zero network use.
- [Search-prompt eval seed-rerun contract](docs/search-prompt-eval-seed-rerun.md) — documented seed 5492, rerun steps, and expected determinism for the search-prompt regression eval.
- [Deployment runbook](docs/deployment-runbook.md) — preview-server image build, staging/preview-only run, env contract, rollback; no production activation.
- [Local pre-push check](docs/pre-push-check.md) — run the same gates CI runs before you push.
- [Nightly ingestion-smoke triage runbook](docs/ingestion-smoke-triage-runbook.md) — where the `17 6 * * *` cron surfaces, who triages, first 5 commands, bug-card vs re-run rule.
- [Production incident runbook](docs/incident-runbook.md) — staging/prod rollback steps, health-check commands, owner/approver per step; staging executable, production dormant.
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
- [No-JS fallback](docs/wayselect-no-js-fallback.md) — what renders with JavaScript disabled on the listing-detail page (full `<noscript>` content, pinned offline).
- [`WAYSELECT_*` env-var matrix](docs/wayselect-env-var-matrix.md) — `WAYSELECT_PREVIEW`, `WAYSELECT_TRUSTED_PROXY_IP`, `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS`, `WAYSELECT_ALLOW_NETWORK` defaults, scope, and who sets each.

## Contributing

Full contributor guide (setup, ground rules, branch/PR, gates, review and
merge): [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

- Tests stay offline: the suite runs `node --test` with pinned packages only; the `transport` test fails if `fetch` is called, server tests bind an ephemeral port and talk to it over `localhost`/`127.0.0.1`, and the probe tests run the CLI against saved local input (`--input`). No test performs a live network fetch: `--fetch` appears in tests only to assert flag-conflict usage errors, and localhost-only health/accept scripts target the ephemeral test server. Do not add tests that reach the live network.
- Fixture policy: fixtures under `fixtures/` are synthetic and checked in. Add or edit them as data files; refresh stamped provenance through `bin/refresh-catalog-fixtures`, never by hand-editing. Keep unknown fields rejected at the `src/catalog.js` boundary and never guess missing capability data.
- Node 20+ ESM; keep `bin/wayselect` thin and `src/` boundaries intact. Run `npm run accept:fixture-refresh` + `npm run check:drift` after each refresh. No new runtime dependencies without a CTO note.
- Keep README claims accurate to merged behavior only — no compatibility, cost, or savings language.
- Be kind: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies in every project space.

License: MIT — see [LICENSE](LICENSE).

## Security

Found a vulnerability? See [SECURITY.md](SECURITY.md) for how to report it
privately, scope, and response SLA. There is no bug-bounty program.
