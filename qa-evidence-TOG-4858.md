# QA Evidence — TOG-4858 (run `6e55da2c`, 2026-09-26)

Issue: TOG-4858 Wayselect eligibility matrix test script (QA)
Head SHA: 10321dac5f02c73296eb29310a64d06feedd24e3
Branch: TOG-4858-wayselect-eligibility-matrix-test-script-qa
Date (UTC): 2026-09-26
Node: v24.21.0
Command: `npm test` (`node --test test/*.test.js`)

## Re-verification (board-resume run `6e55da2c-6c42-4517-9ee3-eb43274586d3`, 2026-09-26T09:33Z)

- Same head `10321dac5f02c73296eb29310a64d06feedd24e3`; tracked tree unchanged
  (`git status --short`: only this evidence file untracked).
- `npm test` re-run: **14 pass, 0 fail, exit 0** (~374ms, node v24.21.0). Verdict below re-confirmed.
- Key citations re-checked this run (`test/eligibility-matrix.test.js` 123 lines,
  stale rows at `:57-67`; `src/validate-catalog-entry.js` 70 lines;
  `schema/catalog-entry/v1.json` 244 lines): accurate.

## Prior runs (history)

- Run `725c2c2d-eecf-45d7-a82c-8862a0a94a58`: same head, 14 pass / 0 fail (~364ms).
- Run `b3ea7581-7573-4f17-b47b-8b895e435c0f`: same head, 14 pass / 0 fail (~327ms).
- Run `d3aa1a8a-cb8e-4fcb-8a0e-aedcd82f1408`: same head, 14 pass / 0 fail (~334ms).

## Result

| Suite | Result |
|---|---|
| eligibility matrix (`test/eligibility-matrix.test.js`) — 10 tests, incl. 2 stale-catalog-fail-closed rows | 10/10 pass |
| catalog-entry validation, TOG-4830 (`test/validate-catalog-entry.test.js`) — 4 tests | 4/4 pass |
| **Total** | **14 pass, 0 fail** |

## Acceptance check

- Script runs green: YES (`npm test` exit 0, 14 pass / 0 fail).
- Covers stale-catalog fail-closed case: YES, twice —
  `test/eligibility-matrix.test.js:57-61` (stale `schemaVersion: "v0"` → `stale-catalog-fail-closed`) and
  `test/eligibility-matrix.test.js:62-67` (missing `schemaVersion` → `stale-catalog-fail-closed`),
  plus guard `test/eligibility-matrix.test.js:89-94` (matrix must keep ≥1 stale row),
  `test/eligibility-matrix.test.js:109-115` (no rejected entry classifies eligible),
  `test/eligibility-matrix.test.js:117-122` (every rejection carries `source=` + `fetchedAt=` provenance).
- Anchored to TOG-4830 schema: YES — classifier imports `SCHEMA_VERSION` / `validateCatalogEntry`
  from `src/validate-catalog-entry.js:1-70`, which enforces `schema/catalog-entry/v1.json:1-244`
  (`additionalProperties: false` at every level, `schemaVersion` const `v1`).

## Matrix rows (7)

1. well-formed v1 entry → eligible (`test/eligibility-matrix.test.js:43-49`)
2. malformed entry → ineligible (`test/eligibility-matrix.test.js:50-55`)
3. stale schemaVersion (v0) → stale-catalog-fail-closed (`test/eligibility-matrix.test.js:57-61`)
4. missing schemaVersion → stale-catalog-fail-closed (`test/eligibility-matrix.test.js:62-67`)
5. unauthorized unknown fields → ineligible (`test/eligibility-matrix.test.js:68-73`)
6. null entry → ineligible (`test/eligibility-matrix.test.js:74-79`)
7. array entry → ineligible (`test/eligibility-matrix.test.js:80-85`)

## Verdict

`QA 10321dac5f02c73296eb29310a64d06feedd24e3: PASS` (local)

## Control-plane registration (run `6e55da2c`, 2026-09-26T09:33Z) — DEGRADED

Bridge degraded (calls via run-scoped `PAPERCLIP_API_URL`, each failing after ~10s worker timeout):

- Reads: `GET heartbeat-context` → 409 `outcome: indeterminate`; `GET issue` → 409 `outcome: indeterminate`.
- Evidence upload (`paperclip-upload-artifact.sh qa-evidence-TOG-4858.md`, run-local state dir):
  attempt 1 → 409 `outcome: indeterminate` (upload-status 75; `.uncertain` marker kept, no `--retry-unknown-upload`).
  Retry deferred: a follow-up `GET attachments` probe also returned 409 indeterminate, so the helper's
  reconcile-by-listing cannot confirm non-commit; retrying blind risks a duplicate.
- Disposition PATCH (`PATCH /api/issues/{id}`, `in_progress` + verdict comment + `executionPolicy.monitor`
  `nextCheckAt 2026-09-26T10:15:00Z`, kind `external_service`, service `paperclip-control-plane-bridge`,
  `maxAttempts 5`, `timeoutAt 2026-09-27T09:00:00Z`; payload at `.paperclip-runtime/scratch/patch.json`):
  attempt 1 → 409 `outcome: indeterminate`; attempt 2 (after 20s) → same. Retries stopped per bounded-write rule.
- **Disposition NOT set; evidence NOT registered; no monitor scheduled.** Second consecutive run on this card
  ending without disposition due to the same bridge error (previous run `725c2c2d`). This file (committed
  locally) plus the adapter/runtime status channel are the fallback record.

## What could NOT be verified / done by QA

- Merge NOT done: `Done = merged for code; green-unmerged is not done.` No `main` ref exists locally,
  GitHub broker reports `broker_transport_unavailable`, so push/PR/CI cannot be verified from here.
  Merging is not QA's job; hand off to engineering with Code Reviewer review of the exact head SHA + green CI before merge.
- Code Reviewer approval on head SHA 10321da NOT verified here (out of QA scope per mission).

## Next action (owner / engineering)

1. Register this file as attachment + `artifact` work product on TOG-4858 (attempted this run — see above).
2. Engineering: PR branch → main, Code Reviewer reviews exact head SHA `10321da`, CI green, then merge.
3. Then mark TOG-4858 `done` (merged + evidence registered). Do NOT mark `done` on green-unmerged alone.
