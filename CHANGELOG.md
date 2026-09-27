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

- #TBD (2026-09-27) TOG-6364: `Allow` header on all 405s (RFC 9110 s15.5.6)
  via a shared `sendMethodNotAllowed` helper; /listings index 405s on
  non-GET instead of 404 (`web/server.js`, `test/method-not-allowed.test.js`).
- #95 (2026-09-27) TOG-6381: multi-seed eval stability — 3 tests
  assert repeatability, v2/v3 shuffle-invariance, v3 goldens, and identical
  CLI SUMMARY across one seed per shuffle class incl. 5492
  (`test/search-prompt-multi-seed.test.js`, test-only, no prod change).
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
