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

- TOG-7304: Host-header / X-Forwarded-Host handling audit pin — hostile
  Host/XFH values leave no trace in index/detail/fragment/404/seller-intake
  output, no route redirects, links stay relative, and rotating Host/XFH
  mints no rate-limit budget (XFH ignored even behind the trusted proxy)
  (`test/host-header-audit.test.js`, test-only, no source change: the
  server never reads Host/XFH).
- TOG-7277: gateway 401 contract pin — missing/wrong bearer key returns
  byte-identical status/body/headers with `WWW-Authenticate: Bearer`
  carried on the 401 result for a future HTTP binding to forward verbatim
  (`src/gateway.js`, `test/gateway.test.js`,
  `bin/accept-wayselect-gateway-phase1`).
- TOG-7315: debt-marker introduction gate — `bin/check-no-todo-markers`
  (stdlib-only, case-sensitive whole-word match, PNG-safe, skips
  `.git`/`node_modules`/`coverage`) runs as the `marker-gate` CI job
  without `npm ci`; newly added marker words fail the run
  (`bin/check-no-todo-markers`, `test/no-todo-markers.test.js`,
  `.github/workflows/ci.yml`, CI-only).
- #146 (2026-09-27) TOG-6371: IPv6-mapped IPv4 normalization pin —
  `resolveClientIp` trusted-proxy matching and XFF client identity share
  one bucket across plain/mapped/upper/translated/loopback spellings
  (`test/ipv6-mapped-resolve-pin.test.js`, test-only, no source change).
- TOG-6712: bounded JSON body reads — `readJsonBody` carries a 10s total
  read deadline (`MAX_JSON_BODY_READ_MS`) that fails closed with
  `body_timeout` (408 at the seller route, retryable; drains the stream
  for socket reuse) instead of hanging on a short/stalling body
  (`web/jsonBody.js`, `web/server.js`, `src/intakeLimits.js`,
  `test/json-body-read-timeout.test.js`).
- #141 (2026-09-27) TOG-6723: `--version` 0.0.0 fallback pin — missing or unparseable manifest (or a non-string version) degrades to `wayselect 0.0.0`, exit 0, without touching the real manifest (`test/cli-version-fallback.test.js`, test-only).
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
- #126 (2026-09-27) TOG-6714: clear delayed detail-fragment timer on
  client abort — `req.once('close')` → `clearTimeout`, fired-timer path
  removes its own listener and skips the send on a dead socket; abort
  leaves zero pending timers (fail-to-pass pin) (`web/server.js`,
  `test/detail-fragment-abort.test.js`).
- #130 (2026-09-27) TOG-6721: over-offset empty-page contract — far-over-offset
  windows return an empty page with the total intact (pure-function level) and
  200, never 400, with the full/filtered match count over HTTP
  (`test/listing-over-offset.test.js`, test-only).
- #128 (2026-09-27) TOG-6730: corrupt search-index `--previous` behavior
  pin — CLI fails closed (exit 1, empty stdout, no output written) on
  non-JSON/truncated/wrong-tool/empty-entries/missing files, exact
  `SearchIndexError` strings pinned, rebuild-from-fixture recovery covered
  (`test/search-index-corrupt-previous.test.js`, test-only).
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
