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

- #116 (2026-09-27) TOG-6384: purchase refusal body contract — exact
  403 `{error: "preview_only", message}` body pinned (keys, message
  verbatim, flag-on/off, trailing slash, 404-first boundary)
  (`test/purchase-refusal-body-contract.test.js`, test-only, no prod
  change).
- #115 (2026-09-27) TOG-6375: preview-disabled JSON fragment contract —
  flag-off detail requests negotiating `Accept: application/json` 404
  with `{error: "preview_disabled"}` (HTML default and HTML-only index
  unchanged) (`web/server.js`, `test/preview-disabled-json.test.js`).
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
