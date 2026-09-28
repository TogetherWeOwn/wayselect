# Changelog

All notable changes to Wayselect are documented here, newest first.
Each entry names the merged PR so a reviewer can trace it back to the diff.

## Release-note process

1. Every merged PR gets one entry under `## Unreleased`, added in the same PR.
2. The PR author writes the entry before requesting review.
3. One line per PR: PR number, TOG id, what changed, files touched.
4. Test-only and docs-only PRs get entries too — they pin behavior.
5. The Code Reviewer verifies the entry matches the diff during review.
6. On release, the releaser renames `Unreleased` to the version plus date.
7. Keep entries newest-first; never rewrite already-released sections.
8. If unsure whether a change needs an entry, add one — short is fine.
9. The Chief Product Officer owns this process and resolves disputes.
10. This note is ten lines; keep it that way when editing.

## Unreleased

- TOG-9168: pin listing `q` unicode contract — `trim().toLowerCase()` only, no
  NFC/NFKC normalization or casefold (test/listing-filter-unicode.test.js).
- #214 (2026-09-28) TOG-8429: deep-nesting DoS fix — `assertNoLocationFields` in
  `src/sellerSubmission.js` and `src/purchase.js` recursed one frame per
  nesting level, so a single 6000-deep `provenance.nested` body (~36KB, under
  the 64KB gate) escaped the typed-error catch as an uncaught RangeError and
  killed the preview process; both scanners are now explicit frame-stack loops
  that replay the old recursion's depth-first pre-order exactly
  (byte-identical first-forbidden key, proven differentially) and fail closed
  with the same typed errors, pinned by `test/intake-deep-nesting.test.js`
  (unit at 6000/10000 depth, pre-order ordering cases, plus live 400 +
  `/healthz` + valid-intake survival).
- #165 (2026-09-28) TOG-6719: gateway rejects unknown top-level body keys —
  400 `invalid_request_error`/`unknown_field` naming the key (R4-13);
  G15 pins the rejection, G16 pins §1.1 pass-through keys still route
  (`src/gateway.js`, `test/gateway.test.js`).
- #206 (2026-09-28) TOG-7300: catalog-import quarantine human-output golden — the
  `Quarantined N:` block of `wayselect catalog import` (count, `  - route:
  reason` lines, exact placement around the ingested/not-written lines) is
  pinned byte-identical for a one-quarantine fixture
  (`test/catalog-import-quarantine-golden.test.js`, test-only, no source
  change: `bin/wayselect` already renders the block).
- #211 (2026-09-28) TOG-8333: unified `--help` golden across all four bins —
  `test/cli-help-all-bins.test.js` pins exit-0/empty-stderr plus exact usage
  bytes for `wayselect`, `wayselect-snapshot`, `wayselect-snapshot-prune`
  (not covered elsewhere) and `wayselect-search-index-refresh`; test-only, no
  source change (the snapshot/refresh `--help` fix itself landed via #216,
  pinned in `test/cli-errors.test.js`).
- #224 (2026-09-28) TOG-8326: in-band `schemaVersion: "v1"` marker on every
  `--json` payload — `select`/`explain`/`catalog import` outputs carry a
  top-level version marker (`const: "v1"` in `schema/cli-json/v1.json`,
  mirroring `SCHEMA_VERSION`), so consumers pin on the marker and a breaking
  change must bump the version per `docs/cli-json-contract.md` instead of
  shifting silently; pinned by `test/cli-json-schema-version.test.js`
  (live-output marker + validation, reject dropped/wrong marker,
  `SCHEMA_VERSION` pinned to `"v1"`) (`bin/wayselect`,
  `schema/cli-json/v1.json`, `docs/cli.md`, `docs/cli-json-contract.md`,
  `test/cli-json-schema-version.test.js`,
  `test/fixtures/cli-json-*.v1.json`, `test/cli-empty-inputs.test.js`).
- #221 (2026-09-28) TOG-8613: hand-edited snapshot tamper-reason pin — new
  test asserts the stable `contentHash: recomputed hash does not match the
  recorded hash` + `backfill may be tampered or edited by hand` reason for a
  tampered snapshot entry (library audit + `bin/check-ingestion-provenance`
  CLI), independent of the TOG-7660 declared-hash bug (test-only, no source
  change: `src/provenanceAudit.js` already emits the reason)
  (`test/snapshot-tamper-reason.test.js`).
- #218 (2026-09-28) TOG-8619: Dockerfile non-root USER + healthcheck pin — new
  contract test pins the effective runtime user as `node` (no `USER root`/`0`),
  pins `HEALTHCHECK` on `/wayselect-healthz` expecting its 404, and proves the
  target working with a live-server 404 check with preview on and off
  (`test/dockerfile-user-healthcheck.test.js`, test-only, no source change).
- #222 (2026-09-28) TOG-6030: purchase idempotency-key support (gap G2) — optional opaque
  `idempotencyKey` on the purchase validator (absent normalizes to null,
  blank/mistyped/overlong >256 fail closed) and optional `Idempotency-Key`
  header on POST purchase (same key replays the 403 refusal with
  `replayed: true`, no duplicate effect; same key on a different route is
  422 `idempotency_key_reused`; blank/overlong is 400; never masks the
  404/405 gates), with OpenAPI + route-table pins (`src/purchase.js`,
  `src/intakeLimits.js`, `src/index.js`, `web/server.js`,
  `test/purchase-idempotency-key.test.js`, `test/preview-route-table.test.js`,
  `docs/preview-server.openapi.json`).
- #205 (2026-09-28) TOG-7309: forced-colors badge treatment audit — the eligibility/
  capability badges (`.badge-*`) were the one author-colored surface with
  no `forced-colors: active` rule (focus rings got theirs in #137), so
  High Contrast flattened every variant to identical boxes; one new rule
  per layout (`.badge { border: 1px solid CanvasText; }`, buttons need
  nothing — native controls draw their own borders), pinned by a 5-test
  guard over every listing + seller page (`web/listing-detail.js`,
  `web/seller.js`, `test/forced-colors-badges.test.js`).

- #202 (2026-09-28) TOG-7314: /listings pagination filter-persist audit pin — `pageHref`
  keeps q, capability, modality and limit on Prev/Next, numbered pages,
  and the past-end recovery link, with a served round-trip following Next
  under q; test-only, no source change (audit: filters already preserved)
  (`test/listing-pagination-filter-persist.test.js`).
- #216 (2026-09-28) TOG-7659: snapshot and search-index-refresh `--help` —
  both staging CLIs treated `--help`/`-h` as a value flag and failed with
  `Missing value for --help` (exit 1); now print usage to stdout with exit 0
  before value-flag parsing, mirroring `bin/check-provenance-drift`, with
  regression tests pinning exact usage bytes (`bin/wayselect-snapshot`,
  `bin/wayselect-search-index-refresh`, `test/cli-errors.test.js`).
- #200 (2026-09-28) TOG-6727: snapshot-prune directory confinement —
  `bin/wayselect-snapshot-prune` refuses a `--dir` containing `..`
  segments (exit 2, `--dir must not contain .. segments`, zero files
  deleted) before any listing or deletion; resolved absolute scratch dirs
  stay legal (`bin/wayselect-snapshot-prune`, `src/cliErrors.js`,
  `src/index.js`, `docs/snapshot-retention.md`,
  `test/snapshot-prune.test.js`).
- TOG-7311: aborted detail-fragment user-visible copy pin — an aborted
  delayed fragment shows the `role="alert"` error panel and `role="status"`
  announcement ("Couldn't load listing details. Check your connection and
  retry."), clears `aria-busy`, and focuses Retry (which re-issues the same
  JSON fragment request); no `AbortError` special-case in the shell script,
  pinned offline by `test/detail-fragment-abort-copy.test.js` via `node:vm`
  execution of the real inline script (test-only, no source change: server
  timer cleanup landed in #126).
- #194 (2026-09-28) TOG-6061: route-table drift pin — contract test
  extracts exact-path and regex dispatch operands from `web/server.js` and
  set-compares them against `docs/preview-server.openapi.json` paths (plus
  `routeBucket` lockstep), failing with the stale side named
  (`test/preview-route-table.test.js`).

- #54 (2026-09-28) TOG-5747: provenance-drift JSON report pinned to v1 schema —
  `bin/check-provenance-drift --out` shape is now fail-closed
  (`schema/drift-report/v1.json`: exact D1/D2/D3 check table, written on
  green and red runs alike) with green + three red runs asserted
  (`test/drift-report-schema.test.js`, test-only, no source change).
- #191 (2026-09-28) TOG-6043: README deploy section matches landed runbook — new
  "Deploying the preview server (staging only)" section (Docker build/run,
  health-probe verify, three-variable env contract, merge-to-main staging
  deploy, reviewer-gated production, rollback pointer) plus the runbook link
  in the docs index (`README.md`).
- #199 (2026-09-28) TOG-7294: purchase-route 405 `Allow` header pin — every non-POST method
  on `/listings/:provider/:model/purchase` 405s with `Allow: POST`
  (status + Allow + content-type + nosniff + exact
  `{error:"method_not_allowed"}` body), trailing-slash parity, 405
  precedes the listing check on unknown listings, and the method gate
  precedes the preview flag (`test/purchase-405.test.js`, test-only, no
  source change: `web/server.js` already routes through
  `sendMethodNotAllowed`).
- #209 (2026-09-28) TOG-8345: security policy for open-sourcing — new `SECURITY.md`
  with private GitHub-Advisory reporting, 72h-ack / 7d-assess / 30d-fix SLA,
  fixture-only scope with explicit out-of-scope list, and a no-bounty statement;
  README gains a Security section pointer (`SECURITY.md`, `README.md`).
- #204 (2026-09-28) TOG-7290: empty-input `select` CLI UX pin — empty catalog (empty body +
  empty configuration) prints the zero-candidate `no-eligible-route` page
  (human + `--json`, exit 3), empty configuration excludes every fixture
  candidate with its reason on both outputs (exit 3, `--json` validates
  against the v1 schema), and empty catalog with the default configuration
  fails closed on the first dangling route (exit 1); the empty-catalog
  `--json` shape (`rankedCandidates: []`) is documented as not validating
  under the current v1 `minItems: 1` bound (`test/cli-empty-inputs.test.js`,
  test-only, no source change).
- #208 (2026-09-28) TOG-7131: host-mediated deploy trigger — both deploy jobs move to
  `ubuntu-latest` (the PUBLIC repo can never match the org's
  `allows_public_repositories=false` self-hosted groups, so those labels
  queued forever); Coolify rebuilds from the host mirror via autodeploy with
  the panel bearer held host-side (TOG-7094), and GitHub owns the Deployment
  record plus target gate (URL-only), mirror settle, /healthz poll, and
  post-deploy smoke. No panel credential in the workflow
  (`.github/workflows/ci.yml`, `scripts/check-deploy-target.mjs`,
  `test/check-deploy-target.test.js`).
- #203 (2026-09-28) TOG-7287: no-JS fallback audit for listing-detail — `docs/wayselect-no-js-fallback.md`
  states what renders with JS disabled (full `<noscript>` body N1–N8, byte-identical
  to the fragment; skeleton/fetch/retry inert), README docs-index link, pinned
  offline by `test/listing-detail-no-js.test.js` (docs + test only, no source
  change: the noscript branch already renders `listingDetailBody`).
- TOG-7275: /listings pagination nav semantics — Previous/Next links carry
  `rel="prev"`/`rel="next"`, numbered page links name each page with
  `aria-current="page"` on the current one (first/last/first±2 windowed),
  pinned offline by `test/listing-pagination-semantics.test.js`
  (`web/listing-detail.js`, `test/listing-pagination-semantics.test.js`).
- #192 (2026-09-28) TOG-7281: warn-only large-catalog benchmark CI job — the `large-catalog-bench`
  job runs `node bin/benchmark-large-catalog` and uploads the timings JSON as
  the `large-catalog-timings` artifact; a budget miss annotates `::warning::`
  and never reds (budgets stay enforced by
  `test/large-catalog-benchmark.test.js`), with a P9 local mirror in
  `bin/pre-push-check` pinned by `test/pre-push-parity.test.js`
  (`.github/workflows/ci.yml`, `bin/pre-push-check`,
  `test/pre-push-parity.test.js`, `docs/pre-push-check.md`,
  `docs/large-catalog-benchmark.md`, `CONTRIBUTING.md`,
  `.github/pull_request_template.md`).
- #198 (2026-09-28) TOG-6725: drift-check CLI exit-code contract pin —
  `bin/check-provenance-drift` asserts 0 clean, 1 on drift, 2 on usage
  error in one place (`test/drift-exit-code-contract.test.js`, test-only,
  no source change).
- #187 (2026-09-28) TOG-7302: catalog import --json pinned to the v1 machine
  schema — the schema is now a `command`-dispatched union (`select`/`explain`
  plus the `catalog import` shape), enforced fail-closed via
  `src/validate-cli-json.js`, with live output pinned byte-for-byte to
  `test/fixtures/cli-json-catalog-import.v1.json` so any machine-shape drift
  fails (`schema/cli-json/v1.json`, `src/validate-cli-json.js`,
  `test/cli-json-contract.test.js`,
  `test/fixtures/cli-json-catalog-import.v1.json`,
  `docs/cli-json-contract.md`).
- #172 (2026-09-28) TOG-7278: staging smoke probes the gateway — 401 on
  missing/wrong key (byte-identical, WWW-Authenticate, no transport call)
  and auto-route dry run (200, dryRun+synthetic, one FakeTransport call),
  in-process with a per-run throwaway key. Files:
  bin/smoke-wayselect-staging-preview, support/gateway-smoke-probes.js,
  test/smoke-gateway-probes.test.js, test/smoke-staging-preview.test.js.
- #201 (2026-09-28) TOG-6050: cache headers on cacheable GETs — fixture-
  deterministic success JSON (`GET /healthz`, flag-on index 200 JSON, detail
  200 JSON fragment) carries `ETag` (strong sha256 content hash) +
  `Cache-Control: public, max-age=60` with 304 on matching `If-None-Match`;
  HTML, error JSON (`no-store`), and seller-transactional JSON unchanged
  (`web/server.js`, `test/cacheable-get-etag.test.js`,
  `test/json-error-no-store.test.js`, `docs/preview-server.openapi.json`).
- #190 (2026-09-28) TOG-6733: sticky filter inputs on the index page — the
  filter form echoes submitted `q`/`limit`/`offset` (escaped, from validated
  `pageInfo`) so re-submits keep the current page window; 3-test guard
  (`web/listing-detail.js`, `test/listing-filter.test.js`,
  `test/listing-filter-labels.test.js`).
- #167 (2026-09-28) TOG-7283: POST intake rate-limit coverage audit pin — every POST
  intake route (`/listings/:provider/:model/purchase`,
  `/sellers/submissions`,
  `/sellers/submissions/:provider/:model/confirm`) asserts its own
  per-IP budget (max passes, then 429 + matching Retry-After with the
  `rate_limited` body), plus POST-bucket independence
  (`test/post-rate-limit-coverage.test.js`, test-only, no source
  change: the limiter already gates every route shape).
- #197 (2026-09-28) TOG-6726: atomic snapshot writes — `bin/wayselect-snapshot`
  publishes snapshots and diff reports via temp-file + fsync + rename
  (`src/atomicWrite.js`), so a mid-write crash leaves the previous file
  byte-identical instead of a corrupt half-written file; 5-test partial-write
  pin (`test/snapshot-atomic-write.test.js`).
- #183 (2026-09-28) TOG-7296: overlong-q fail-closed exact-bytes pin — `q`
  beyond `LISTINGS_MAX_QUERY_LENGTH` (200) fails closed with kind `q`, the
  echo exactly the first 64 input chars, `valid: ["at most 200 characters"]`,
  and the 400 paragraph renders those bytes verbatim without the full input
  (`test/listing-overlong-q.test.js`, test-only, no source change:
  `web/filter.js` already truncates at 64 and `web/listing-detail.js`
  already renders the single-error paragraph).
- #195 (2026-09-28) TOG-6728: large-fixture generator determinism pin — test-only run-twice
  byte-identical assertion on `generateLargeCatalog()` CLI write bytes plus explicit
  seed/time default pin and seed-divergence guard; documents the seed knob
  (`test/large-fixture-determinism.test.js`).
- #180 (2026-09-28) TOG-7307: gateway intake-limits enforcement matrix pin — `src/intakeLimits.js`
  gains `MAX_GATEWAY_MESSAGES` (32), `MAX_GATEWAY_MESSAGE_CHARS` (16k), and
  `MAX_GATEWAY_TOTAL_CHARS` (64k), enforced fail-closed in `src/gateway.js`
  with 400 `too_many_messages` / `message_too_large` / `messages_too_large`,
  pinned by a pass/reject boundary matrix plus a joined-parts normalization
  row (`src/gateway.js`, `src/index.js`, `src/intakeLimits.js`,
  `test/gateway-intake-limits.test.js`).
- #184 (2026-09-28) TOG-7317: CHANGELOG Unreleased-entry CI gate — new
  `changelog-gate` workflow runs `node bin/check-changelog-entry` on
  `pull_request` (fetch-depth 0): a PR touching `src/`, `web/`, `bin/`, or
  `test/` without a new `- ` bullet under `## Unreleased` naming a TOG id
  reds; docs-only, fixture-only, and CHANGELOG-only PRs skip green, pinned
  offline by `test/changelog-entry-gate.test.js` against scratch git repos
  (`.github/workflows/changelog-gate.yml`, `bin/check-changelog-entry`,
  `test/changelog-entry-gate.test.js`).

- #186 (2026-09-28) TOG-7274: seller skip-link parity — served `/sellers` confirm, receipt,
  missing-intent, and rejection pages carry the same focusable skip link +
  `#main-content` target as the listing pages; 4-test served-route guard
  (`test/seller-skiplink.test.js`).

- #182 (2026-09-28) TOG-7661: flag-on index honors `Accept:
  application/json` — 200 paged result `{listings, total, limit, offset}`
  (incl. empty state and offset-past-end with intact total), 400
  `{error: invalid_filter, kind, value, valid, errors}` for every filter
  kind incl. sort (with the TOG-6717 request id), HTML default for
  browsers, `Vary: Accept` on every flag-on variant; flag-off index stays
  HTML-only (`web/server.js`, `test/listing-index-json.test.js`,
  `test/vary-accept.test.js`, `test/preview-disabled-json.test.js`,
  `test/preview-route-table.test.js`, `docs/preview-server.openapi.json`).
- #175 (2026-09-28) TOG-7292: empty-q vs missing-q filter contract pin —
  absent `q`, `?q=`, and bare `?q` all parse `ok:true` to identical `q: ""`
  filters, match the full stub catalog in stub order, and serve identical
  200 index bodies (nonce-normalized)
  (`test/empty-q-filter-contract.test.js`, test-only, no source change:
  empty q already folds to no text filtering).
- #131 (2026-09-27) TOG-6910: deploy-on-merge to Coolify staging +
  reviewer-gated production — `deploy-staging`/`deploy-production` jobs in
  `.github/workflows/ci.yml` (self-hosted runners, bearer-header transport
  per the fleet's two-bot DEPLOY.md §6.1, `environment:` Deployment records,
  serialized concurrency, fail-closed `check-deploy-target` gate, mirror
  settle, `/healthz` settle, post-deploy `smoke-wayselect-staging-preview`);
  reconciled with main's `search-index-probe`/`e2e-staging-acceptance` jobs
  (`scripts/check-deploy-target.mjs`, `scripts/wait-for-host-mirror.mjs`,
  `scripts/wait-for-staging-health.mjs`, `test/check-deploy-target.test.js`,
  `test/deploy-helpers.test.js`).
- #181 (2026-09-28) TOG-6368: noindex on preview pages — every HTML page
  carries `<meta name="robots" content="noindex, nofollow">` (both layouts)
  and every HTML response carries `X-Robots-Tag: noindex, nofollow`;
  JSON responses carry neither. 6-test guard
  (`web/listing-detail.js`, `web/seller.js`, `web/server.js`,
  `test/preview-noindex.test.js`).
- #60 (2026-09-28) TOG-5738: deployment runbook with Dockerfile and rollback —
  `node:20-slim` prod image (`npm ci --omit=dev`, non-root, `HOST=0.0.0.0`,
  HEALTHCHECK on the 404 `not_found` contract), `.dockerignore`, plus
  build/run/verify/rollback runbook (`Dockerfile`, `.dockerignore`,
  `docs/deployment-runbook.md`).
- #177 (2026-09-28) TOG-6040: preview-server route table — OpenAPI 3.1 doc
  covering every route/method/params/status in `web/server.js` (incl.
  `sort` vocabulary, `x-request-id` triage envelope, case-sensitive
  lookup), linked from the README docs index, with static + live route
  coverage (`docs/preview-server.openapi.json`,
  `test/preview-route-table.test.js`, `README.md` docs index).
- #179 (2026-09-28) TOG-7321: `WAYSELECT_*` env-var matrix operator doc —
  one ops table for `WAYSELECT_PREVIEW`, `WAYSELECT_TRUSTED_PROXY_IP`,
  `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS`, `WAYSELECT_ALLOW_NETWORK`
  (default, scope, who sets each, with source line refs per row), plus a
  README docs-index link and an 8-test source-pin guard
  (`docs/wayselect-env-var-matrix.md`, `test/env-var-matrix.test.js`,
  `README.md`).
- #178 (2026-09-28) TOG-7280: npm audit CI gate — the `audit` job runs
  `npm audit --audit-level=high` after `npm ci`, so a new high/critical
  advisory reds CI; registry-dependent, so CI-only by design with the
  exclusion documented in `bin/pre-push-check`, `docs/pre-push-check.md`,
  and `CONTRIBUTING.md` and pinned by `test/npm-audit-gate.test.js`
  (`.github/workflows/ci.yml`, `test/npm-audit-gate.test.js`,
  `bin/pre-push-check`, `docs/pre-push-check.md`, `CONTRIBUTING.md`,
  `test/pre-push-parity.test.js`).
- #176 (2026-09-28) TOG-6736: `bin/` operator catalog doc — one line per
  script (purpose, when to run, key flags) covering all 29 executables,
  plus a README docs-index link
  (`docs/bin-operator-catalog.md`, `README.md`).
- #174 (2026-09-28) TOG-7842: no-network guard preload in the
  fixture-refresh suite step — the `suite`-step spawn gains
  `--import ./support/no-network-guard.js` to match `npm test`
  (`bin/accept-fixture-refresh`, `test/listing-uppercase-path.test.js`).
- #156 (2026-09-28) TOG-5745: daily fixture-freshness check — scheduled CI
  job runs the read-only `npm run refresh:check` daily at 07:23 UTC and
  opens a deduplicated `fixture-staleness` issue on failure
  (`.github/workflows/fixture-refresh-check.yml`,
  `test/fixture-refresh-scheduler.test.js`, `README.md`).
- #153 (2026-09-28) TOG-7541: dependabot github-actions prefix
  `chore(deps)` → `ci(deps)` per the org GitHub standard
  (`.github/dependabot.yml`, CI-only, no prod change).
- #170 (2026-09-28) TOG-6044: trailing-slash canonical pin — `/listings` vs `/listings/`
  (and detail `.../p/m` vs `.../p/m/`) both stay 200 with identical bodies
  and carry `<link rel="canonical">` to the slashless path (index, detail
  shell, legacy full render); no redirects
  (`web/listing-detail.js`, `test/listings-canonical.test.js`).
- #105 (2026-09-28) TOG-6738: `WAYSELECT_PREVIEW` truthiness truth table pin —
  enabled spellings `1`/`true`/`yes`/`on` vs disabled unset/empty/`0`/`false`/
  `no`/`off` and every other spelling (`test/preview-flag-truth-table.test.js`,
  test-only, no prod change).
- #166 (2026-09-28) TOG-6717: request id on JSON errors — every JSON error
  carries a crypto-random `x-request-id` header echoed as `requestId` in the
  body (128-bit hex, distinct per response, header/body agree; success JSON
  unchanged), so staging triage can match responses to logs
  (`web/server.js`, `test/request-id-json-errors.test.js`, plus
  `requestId` tolerance in 12 routing-test pins and updated key lists in
  the 429/purchase-refusal shape contracts).
- #168 (2026-09-28) TOG-6042: nightly ingestion-smoke failure-triage runbook — where the
  `17 6 * * *` cron result surfaces, who triages, first 5 diagnostic
  commands, and bug-card vs re-run rule, with a green-cron acceptance
  check (`docs/ingestion-smoke-triage-runbook.md`, `README.md` docs index).
- #162 (2026-09-27) TOG-7271: gateway operator-key handling audit pin — hostile
  operator/wrong keys through every gateway error path (401 variants,
  500 misconfig/transport branches, all 400 validators), success bodies,
  transport records, and console capture assert zero key material; the
  `timingSafeEqual` compare and the no-logging-sink shape stay pinned
  statically, and tracked snapshots carry no bearer material
  (`test/operator-key-audit.test.js`, test-only, no source change: every
  error path already returns static messages and auth stays
  byte-identical).
- #161 (2026-09-27) TOG-6362: explicit `sort` param on `/listings` (gap G1) —
  `default` keeps stub order; `price-asc` / `price-desc` order by the synthetic
  list-price estimate with unknown prices last and code-unit route-ID tie-break;
  `name-asc` / `route-asc` for alphabetical orders. Unknown values fail closed
  (400 naming the valid sorts); sort rides the filter form as a native
  `<select>` and survives Prev/Next page links (`web/filter.js`,
  `web/listing-detail.js`, `web/server.js`, `test/listing-filter.test.js`,
  `test/listing-filter-labels.test.js`, `test/listing-pagination.test.js`).
- #160 (2026-09-27) TOG-6711: uppercase provider/model path contract pin —
  `/listings/Northstar/Alpha-Chat` 404s (HTML miss page by default, JSON
  `{error: "listing_not_found"}` on fragment negotiation) instead of
  remapping to the lowercase listing; all case variants 404 identically
  while the canonical lowercase path serves 200
  (`test/listing-uppercase-path.test.js`, test-only, no source change).
- #164 (2026-09-27) TOG-6051: index result-count live region — the
  result-count paragraph carries explicit `aria-live="polite"` alongside
  `role="status"` in all three index states so filter changes announce the
  new count (copy unchanged, no visual change)
  (`web/listing-detail.js`, `test/listing-a11y.test.js`).
- #163 (2026-09-27) TOG-6047: search-prompt eval seed-rerun contract — documented
  seed 5492 with reviewer rerun steps and expected determinism, plus a pin
  test asserting the doc seed matches the script default, npm script, and
  recorded SUMMARY (`docs/search-prompt-eval-seed-rerun.md`,
  `test/search-prompt-eval-seed-rerun.test.js`, `README.md`, docs+test only).
- #159 (2026-09-27) TOG-6052: `check-models-dev-freshness`
  no-network contract doc — what `--input` reads, what the script never
  touches (single `globalThis.fetch` call site gated behind `--fetch`),
  and the operator offline-verification steps, proven by
  `test/models-dev-freshness-offline-contract.test.js`
  (`docs/models-dev-freshness-probe-offline-contract.md`, README docs index,
  docs-only, no source change).
- #158 (2026-09-27) TOG-6731: index page lang/title contract pin — renderer,
  empty state, and live `GET /listings` all carry `<html lang="en">` plus
  exactly one non-empty escaped `<title>` (`Listings — Wayselect`)
  (`test/listing-index-lang-title.test.js`, test-only, no prod change).
- #157 (2026-09-27) TOG-6045: CLI --help/--version golden output pin — exact-byte
  tests for global, select, explain, catalog, and catalog-import help plus
  --version against package.json (`test/cli-golden.test.js`, test-only, no
  source change).
- #155 (2026-09-27) TOG-7319: pre-push vs CI parity audit — `bin/pre-push-check` grows from
  5 to 8 gates (engine, marker, smoke + search-index probe, e2e + demo),
  P2/P3/P4 go recursive and multi-file, and `test/pre-push-parity.test.js`
  pins every CI `run:` step to a local gate; docs (`docs/pre-push-check.md`,
  `CONTRIBUTING.md`, PR template) move to `8 pass, 0 fail`
  (`bin/pre-push-check`, `test/pre-push-parity.test.js`,
  `docs/pre-push-check.md`, `CONTRIBUTING.md`,
  `.github/pull_request_template.md`).
- #103 (2026-09-27) chore(deps): bump `actions/setup-node` 4 → 7
  (`.github/workflows/ci.yml`, `.github/workflows/acceptance.yml`,
  CI-only, no prod change).
- #154 (2026-09-27) TOG-7304: Host-header / X-Forwarded-Host handling audit pin — hostile
  Host/XFH values leave no trace in index/detail/fragment/404/seller-intake
  output, no route redirects, links stay relative, and rotating Host/XFH
  mints no rate-limit budget (XFH ignored even behind the trusted proxy)
  (`test/host-header-audit.test.js`, test-only, no source change: the
  server never reads Host/XFH).
- #138 (2026-09-27) TOG-6716: seller-intent TTL — staged intents expire
  15 min after intake (`SELLER_INTENT_TTL_MS`, injectable `options.now`);
  expired confirms 404 as missing; intake sweeps stale entries
  (`web/server.js`, `test/seller-intent-ttl.test.js`).
- #152 (2026-09-27) TOG-7272: seller-submission echo stored-XSS audit pin — hostile
  strings through every seller-controlled echo path (confirm, receipt
  incl. timestamp, detail, shell, fragment, index, error/missing-intent
  pages, hostile-id form actions and shell fetch) render escaped
  (`test/seller-xss-audit.test.js`, test-only, no source change: every
  path already escapes via `escape-html` + `encodeURIComponent`, and
  the accepted-but-silent `description`/`etag` fields have no echo path).
- #151 (2026-09-27) TOG-7286: concurrent slow-fragment load budget —
  12 parallel listing-detail JSON-fragment hits with
  `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` set all return 200 with intact
  content inside a 2000ms batch budget
  (`test/concurrent-slow-fragment-budget.test.js`, test-only, no source change).
- #150 (2026-09-27) TOG-7277: gateway 401 contract pin — missing/wrong
  bearer key returns byte-identical status/body/headers with
  `WWW-Authenticate: Bearer`
  carried on the 401 result for a future HTTP binding to forward verbatim
  (`src/gateway.js`, `test/gateway.test.js`,
  `bin/accept-wayselect-gateway-phase1`).
- #149 (2026-09-27) TOG-7315: debt-marker introduction gate — `bin/check-no-todo-markers`
  (stdlib-only, case-sensitive whole-word match, PNG-safe, skips
  `.git`/`node_modules`/`coverage`) runs as the `marker-gate` CI job
  without `npm ci`; newly added marker words fail the run
  (`bin/check-no-todo-markers`, `test/no-todo-markers.test.js`,
  `.github/workflows/ci.yml`, CI-only).
- #148 (2026-09-27) TOG-6708: `Vary: Accept` on content-negotiated routes — seller-intake,
  seller-confirm, listing-detail shell/fragment, and the 404 fallback
  negotiate HTML vs JSON on `Accept`, so every variant carries
  `Vary: Accept` (one `res.setHeader` per route branch); non-negotiated
  routes (healthz, purchase stub, index) stay without it
  (`web/server.js`, `test/vary-accept.test.js`).
- #147 (2026-09-27) TOG-6707: seller-intake 405 carries `Allow: POST` — the intake branch
  routes wrong-method refusals through the shared `sendMethodNotAllowed`
  helper (RFC 9110 §15.5.6) instead of raw `sendJson`; HEAD-contract pin
  updated for the intake path (`web/server.js`,
  `test/seller-intake-405.test.js`, `test/head-method-contract.test.js`).
- #143 (2026-09-27) TOG-6713: cap slowloris header/body receipt —
  `createApp()` pins `headersTimeout` 10s / `requestTimeout` 120s on every
  server it builds (below Node's 60s/300s defaults), with a validated
  `httpTimeouts` override; both values logged at startup
  (`web/server.js`, `test/preview-http-timeouts.test.js`).
- #142 (2026-09-27) TOG-6737: seller-intake vs purchase error-envelope
  parity note — §4A field table + rationale in the seller acceptance
  spec, pinning both HTTP envelopes and both validator vocabularies to
  code (`docs/wayselect-seller-acceptance.md`, docs-only).
- #146 (2026-09-27) TOG-6371: IPv6-mapped IPv4 normalization pin —
  `resolveClientIp` trusted-proxy matching and XFF client identity share
  one bucket across plain/mapped/upper/translated/loopback spellings
  (`test/ipv6-mapped-resolve-pin.test.js`, test-only, no source change).
- #145 (2026-09-27) TOG-6712: bounded JSON body reads — `readJsonBody` carries a 10s total
  read deadline (`MAX_JSON_BODY_READ_MS`) that fails closed with
  `body_timeout` (408 at the seller route, retryable; drains the stream
  for socket reuse) instead of hanging on a short/stalling body
  (`web/jsonBody.js`, `web/server.js`, `src/index.js`, `src/intakeLimits.js`,
  `test/json-body-read-timeout.test.js`).
- #144 (2026-09-27) TOG-5859: capability-aware select output contract —
  typed-requirement JSON validation, selected/no-eligible human output,
  fail-closed missing limits, and executable README example; document the
  v1 `--json` shape and guard it against drift (`test/select-output-contract.test.js`,
  `test/cli-docs-examples.test.js`, `README.md`, `docs/cli.md`, docs/test-only).
- #141 (2026-09-27) TOG-6723: `--version` 0.0.0 fallback pin — missing or unparseable manifest (or a non-string version) degrades to `wayselect 0.0.0`, exit 0, without touching the real manifest (`test/cli-version-fallback.test.js`, test-only).
- #140 (2026-09-27) TOG-5739: structured request logging + 405 Allow
  consistency — one JSON line per request `{method,path,status,latencyMs}`
  via injectable `options.logger`; seller intake/confirm 405s funnel through
  `sendMethodNotAllowed` (`Allow: POST` / `Allow: GET, POST`)
  (`web/server.js`, `test/request-logging.test.js`,
  `test/json-error-no-store.test.js`, `test/head-method-contract.test.js`,
  `test/seller-confirm.test.js`).
- #139 (2026-09-27) TOG-6724: bad `--now` exit-code/no-write contract pin —
  invalid `--now` exits 1 with empty stdout, exact
  `CatalogFreshnessError` bytes, `--out` dir never created, and no
  `--report` file written (fail-before-any-IO)
  (`test/cli-errors.test.js`, test-only).
- #137 (2026-09-27) TOG-5744: visible-focus + reduced-motion polish —
  skip-link transition disabled under `prefers-reduced-motion`, seller
  pages to focus-ring parity (`a`/`button`/`input` + forced-colors),
  pin test for both (`test/listing-focus-motion.test.js`)
  (`web/listing-detail.js`, `web/seller.js`).
- #136 (2026-09-27) TOG-5860: capability-aware select QA golden
  harness — 9 CLI goldens pinning spec acceptance A1–A7 (typed-requirement
  win, impossible threshold, fail-closed unknown data, stale-catalog
  refusal, tie byte-identity, support-state gating, help + README)
  with small newly-authored fixtures only, plus `accept:capability-select`
  (`test/capability-select-golden.test.js`,
  `bin/accept-wayselect-capability-select`, `package.json`, test-only).
- #113 (2026-09-27) TOG-5728: Node test matrix 20.x + 24.x with engine gate —
  fail-fast-false matrix plus a stdlib-only `bin/check-node-engines` gate
  failing fast with ENGINE-MISMATCH before `npm ci`
  (`.github/workflows/ci.yml`, `bin/check-node-engines`).
- #118 (2026-09-27) TOG-5722: wire search-index `--check` probe and e2e
  staging acceptance into CI as fixture-only jobs, no network/credentials
  (`.github/workflows/ci.yml`).
- #120 (2026-09-27) TOG-6383: slow-network knob operator doc (gap T5) —
  `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` contract plus guard test
  (`docs/wayselect-slow-network-knob.md`,
  `test/fragment-delay-knob.test.js`, `README.md`).
- #123 (2026-09-27) TOG-6374: multi-error 400 page — the HTML
  invalid-filter page lists every error (counted list) instead of only
  the first; single-error copy unchanged (`web/filter.js`,
  `web/listing-detail.js`, `test/invalid-filter-multi-error.test.js`).
- #133 (2026-09-27) TOG-5752: designed unknown-listing 404 — search hint
  (`searching the listings` → `/listings?q=<model>`, capped at the index
  `q` bound) plus the listing-index link, in the listing-shell chrome
  (`web/listing-detail.js`, `test/unknown-listing-404.test.js`,
  `docs/wayselect-onboarding-spec.md`, `preview-unknown-listing-404.png`).
- #124 (2026-09-27) TOG-6710: double-encoded purchase path segment
  contract — collapsing `%252F` targets pinned as the listing route's 405
  (POST) / listing miss (GET), never a purchase refusal; exact
  three-segment target still 403; `%252E%252E` and triple encoding decode
  exactly once (`test/purchase-double-encoded-segments.test.js`, test-only).
- #135 (2026-09-27) TOG-5742: catalog-entry version-negotiation note + v1 pin —
  pinned contract, no-silent-upgrade policy, 4-step v2 bump procedure, plus
  `SCHEMA_VERSION` v1 and rejection pins (`docs/catalog-entry-versioning.md`,
  `test/validate-catalog-entry.test.js`).
- #126 (2026-09-27) TOG-6714: clear delayed detail-fragment timer on
  client abort — `req.once('close')` → `clearTimeout`, fired-timer path
  removes its own listener and skips the send on a dead socket; abort
  leaves zero pending timers (fail-to-pass pin) (`web/server.js`,
  `test/detail-fragment-abort.test.js`).
- #134 (2026-09-27) TOG-6392: index heading hierarchy audit — `h1
  Listings` + visible `h2 Filter listings` / `h2 Results` labelledby
  sections on every index state (populated, empty, past-the-end,
  windowed), pinned by a new audit test plus served-route coverage
  (`web/listing-detail.js`, `test/listing-index-headings.test.js`,
  `test/listing-a11y.test.js`, `test/listing-empty-error-states.test.js`).
- #130 (2026-09-27) TOG-6721: over-offset empty-page contract — far-over-offset
  windows return an empty page with the total intact (pure-function level) and
  200, never 400, with the full/filtered match count over HTTP
  (`test/listing-over-offset.test.js`, test-only).
- #128 (2026-09-27) TOG-6730: corrupt search-index `--previous` behavior
  pin — CLI fails closed (exit 1, empty stdout, no output written) on
  non-JSON/truncated/wrong-tool/empty-entries/missing files, exact
  `SearchIndexError` strings pinned, rebuild-from-fixture recovery covered
  (`test/search-index-corrupt-previous.test.js`, test-only).
- #132 (2026-09-27) TOG-6722: invalid `maxCatalogAgeMs` fail-closed pin —
  `-1`/`NaN`/`Infinity` budgets rejected with typed errors at all three
  library entry points (`test/freshness-invalid-budget.test.js`, test-only).
- #122 (2026-09-27) TOG-6369: serve `GET /favicon.ico` as 204 (ungated,
  rate-limit-exempt like `/healthz`; non-GET 405s with `Allow: GET`)
  (`web/server.js`, `test/favicon-route.test.js`,
  `test/method-not-allowed.test.js`).
- #125 (2026-09-27) TOG-6718: duplicate routeId feed policy pin — duplicate
  JSON keys last-win at parse with zero quarantine; slash-collision duplicates
  (`p`+`a/b` vs `p/a`+`b`) are kept by ingest/normalize but fail closed at
  `applySupportConfiguration` (`SupportConfigurationError`), so a duplicated
  feed can never reach selection (`test/ingest-duplicate-route-id.test.js`,
  test-only).
- #129 (2026-09-27) TOG-6377: 500 render-throw fallback contract — shell
  and fragment render throws pinned as 500 HTML with matching per-response
  nonce CSP plus a 200 control (`test/render-throw-fallback.test.js`,
  test-only).
- #127 (2026-09-27) TOG-6720: filter text-match case behavior — mixed-case
  `q` against mixed-case stub names pinned as case-insensitive (exact
  match sets, case-variant equivalence, verbatim-at-parse/fold-at-match)
  (`test/listing-filter-case.test.js`, test-only).
- #117 (2026-09-27) TOG-6380: max-limit listing-index render budget —
  100-row index render under 500ms (300ms control delay) and 64KiB,
  plus `GET /listings?limit=100` live-route smoke
  (`test/listing-render-budget.test.js`, test-only).
- #85 (2026-09-27) TOG-5265: QA fixture harness on current main —
  edge fixtures x8, edge/golden/guard tests, no-network guard wired
  into `npm test`, `scripts/acceptance.sh` gate + workflow
  (`fixtures/edges/`, `test/edge-fixtures.test.js`,
  `test/golden-output.test.js`, `test/golden/default.json`,
  `support/no-network-guard.js`, `test/no-network-guard.test.js`,
  `scripts/acceptance.sh`, `.github/workflows/acceptance.yml`,
  `package.json`).
- #121 (2026-09-27) TOG-6709: HEAD method contract — HEAD pinned as a
  plain wrong method (405 + `Allow` on GET/purchase routes, 405 without
  `Allow` on seller routes, 404 on unknown paths; empty body, method gate
  precedes the preview flag) (`test/head-method-contract.test.js`,
  test-only).
- #119 (2026-09-27) TOG-6394: badge color-contrast guard — WCAG AA
  evidence for the five badge classes (on/granted 8.62, off 7.35,
  blocked 8.49, unknown 7.73), pinned as a failing-if-regressed test
  (`test/badge-contrast.test.js`, test-only).
- #116 (2026-09-27) TOG-6384: purchase refusal body contract — exact
  403 `{error: "preview_only", message}` body pinned (keys, message
  verbatim, flag-on/off, trailing slash, 404-first boundary)
  (`test/purchase-refusal-body-contract.test.js`, test-only, no prod
  change).

- #115 (2026-09-27) TOG-6375: preview-disabled JSON fragment contract —
  flag-off detail requests negotiating `Accept: application/json` 404
  with `{error: "preview_disabled"}` (HTML default and HTML-only index
  unchanged) (`web/server.js`, `test/preview-disabled-json.test.js`).
- #114 (2026-09-27) TOG-6367: `Cache-Control: no-store` on dynamic JSON
  errors (`sendJson` for status >= 400, `sendMethodNotAllowed`, 429
  refusal); success JSON and HTML untouched (`web/server.js`,
  `test/json-error-no-store.test.js`).
- #112 (2026-09-27) TOG-6897: conventional PR title/description lint — `pr-lint`
  job on `ubuntu-latest` with no third-party actions and no checkout, plus
  push-to-main coverage (`.github/workflows/pr-lint.yml`, CI-only).
- #107 (2026-09-27) TOG-6370: `q` length cap (200, fail-closed 400 naming
  the bound) + form `maxlength` hint (`web/filter.js`,
  `web/listing-detail.js`, `test/listing-filter.test.js`,
  `test/listing-empty-error-states.test.js`).
- #111 (2026-09-27) TOG-6378: pin `/healthz` version to the package
  manifest — `SERVER_VERSION` and the probe body must equal
  `package.json` version (`test/preview-server-ops.test.js`, test-only).
- #110 (2026-09-27) TOG-6376: 429 body shape contract test — exact
  `{error: "rate_limited", retryAfterSec}` body pinned (keys, types,
  header agreement) via stubbed-verdict + live-limiter tests
  (`test/rate-limit-body-contract.test.js`, test-only, no prod change).
- #102 (2026-09-27) chore(deps): bump `actions/checkout` 4 → 7
  (`.github/workflows/ci.yml`, CI-only, no prod change).
- #106 (2026-09-27) TOG-6732: index page skip-link + `#main-content`
  parity test vs detail page (`test/listing-index-skiplink.test.js`,
  test-only, no prod change).
- #104 (2026-09-27) TOG-5737: README accuracy audit — 13 claim-level
  fixes vs merged behavior (`README.md`, docs-only, no prod change).
- #101 (2026-09-27) TOG-5749: transport executable-URL rejection fuzz —
  seeded (0x5749) malicious route/catalog shapes all rejected
  (`test/transport-fuzz.test.js`, test-only, no prod change).
- #99 (2026-09-27) TOG-4969: seller intake + confirm + receipt (S7) —
  POST `/sellers/submissions` fail-closed validation, confirm screen
  restating price/capabilities/verdict, intent-only receipt
  (`web/seller.js`, `web/server.js`, `test/seller-confirm.test.js`,
  `scripts/seller-acceptance.sh`, `docs/seller-onboarding-spec-v1.md`).
- #94 (2026-09-27) TOG-6336: large-catalog stress fixture (seeded
  2000-route synthetic catalog) + refresh benchmark budget CLI
  (`scripts/generate-large-catalog.mjs`, `bin/benchmark-large-catalog`,
  `fixtures/catalog.large-synthetic.json`,
  `test/large-catalog-benchmark.test.js`,
  `docs/large-catalog-benchmark.md`, `package.json`).
- #91 (2026-09-27) TOG-6379: concurrent-request test — shared limiter
  budget, per-response nonce uniqueness, route isolation
  (`test/concurrent-requests.test.js`, test-only, no prod change).
- #89 (2026-09-27) TOG-5754: diff-report readability — gap-delta line
  and empty-diff wording in `formatDiffReport` plus regenerated golden
  samples (`src/catalogDiff.js`, `test/snapshot.test.js`,
  `snapshots/diff-report-consecutive-green.md`,
  `snapshots/sample-diff-with-changes.md`).
- #86 (2026-09-27) TOG-6039: README docs index linking every `docs/`
  acceptance spec (`README.md`, docs-only, no prod change).
- #55 (2026-09-27) TOG-5857: S1 typed-requirement flags on
  select/explain (R1, R2) — modalities, context/output bounds,
  tool/structured/reasoning requirements, fail-closed file requirements
  (`bin/wayselect`, `docs/cli.md`, `src/eligibility.js`, `src/index.js`,
  `test/cli.test.js`, `test/ranking.test.js`).
- #100 (2026-09-27) TOG-6386: automated dep-update PRs via Dependabot
  (monthly npm + github-actions, free tier, no auto-merge) + Automation
  section in policy doc (`.github/dependabot.yml`,
  `docs/dependency-update-policy.md`).
- #96 (2026-09-27) TOG-6382: adversarial search-prompt eval — 8 tests
  over a 19-query corpus (override fail-closed, negation robustness,
  KNOWN-GAP pins for n't/name/adjective limits)
  (`test/search-prompt-adversarial.test.js`, test-only).
- #97 (2026-09-27) TOG-6387: npm audit delta record — clean bill vs
  TOG-6037 baseline (0 vulns, lockfile byte-identical, pins unchanged)
  (`audit-delta-evidence.json`, evidence-only).
- #98 (2026-09-27) TOG-6364: `Allow` header on all 405s (RFC 9110 s15.5.6)
  via a shared `sendMethodNotAllowed` helper; /listings index 405s on
  non-GET instead of 404 (`web/server.js`, `test/method-not-allowed.test.js`).
- #95 (2026-09-27) TOG-6381: multi-seed eval stability — 3 tests
  assert repeatability, v2/v3 shuffle-invariance, v3 goldens, and identical
  CLI SUMMARY across one seed per shuffle class incl. 5492
  (`test/search-prompt-multi-seed.test.js`, test-only, no prod change).
- #90 (2026-09-27) TOG-6391: add `.github/pull_request_template.md`
  (what-changed, verification, CHANGELOG, review sections per
  `CONTRIBUTING.md`) (`.github/pull_request_template.md`, `CHANGELOG.md`,
  docs-only, no prod change).
- #88 (2026-09-27) TOG-6388: root `CONTRIBUTING.md` (setup, ground
  rules, branch/PR/gates, review-and-merge policy) + README link
  (`CONTRIBUTING.md`, `README.md`).
- #93 (2026-09-27) TOG-6365: 400 on unknown /listings query params
  (kind=query naming the valid keys) so typos fail closed (`web/filter.js`,
  `test/listing-filter.test.js`, `test/listing-empty-error-states.test.js`).
- #92 (2026-09-27) TOG-6449: "Updating this glossary" checklist for new
  reason codes — Meaning + Display (Blocked/Unknown) + remediation,
  backticked `<placeholder>` templates, out-of-scope labels
  (`docs/eligibility-reasons.md`, docs-only).
- #87 (2026-09-27) TOG-5740: snapshot retention policy (keep-last-10
  + 30 days) with dry-run-default prune CLI (`docs/snapshot-retention.md`,
  `bin/wayselect-snapshot-prune`, `src/snapshotPrune.js`,
  `test/snapshot-prune.test.js`).
- #67 (2026-09-27) TOG-5885: eligibility reason glossary doc plus guard test
  (`docs/eligibility-reasons.md`, `test/eligibility-reasons-glossary.test.js`).
- #82 (2026-09-27) TOG-6049: replace CSP `unsafe-inline` with per-response
  128-bit nonces (`web/server.js`, `web/listing-detail.js`,
  `test/security-headers.test.js`).
- #83 (2026-09-27) TOG-6046: XFF/proxy rate-limit matrix test — direct,
  trusted hop, multi-hop, spoof (`test/xff-rate-limit-matrix.test.js`,
  test-only, no prod change).
- #81 (2026-09-27) TOG-5741: rate-limiter bucket eviction with LRU/TTL and
  `MAX_BUCKETS` cap (default 10,000) (`web/rate-limit.js`,
  `test/rate-limit.test.js`).
- #79 (2026-09-27) TOG-5726: preview server `GET /healthz`, strict PORT
  parsing, SIGTERM/SIGINT graceful shutdown (`web/server.js`,
  `test/preview-server-ops.test.js`).
