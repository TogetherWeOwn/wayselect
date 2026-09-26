# QA Evidence - TOG-4858 (run `f23e7598`, 2026-09-26)

Issue: TOG-4858 Wayselect eligibility matrix test script (QA)
Head SHA: 150e2f7ae25862795ee3419584fc524c1bb71823
Branch: TOG-4858-wayselect-eligibility-matrix-test-script-qa
Date (UTC): 2026-09-26
Node: v24.21.0
Command: `npm test` (`node --test test/*.test.js`)

## Re-verification (board-resume run `f23e7598-2ddd-4a85-8ced-94f3731388db`, 2026-09-26T11:36Z)

- Head `150e2f7`; code tree unchanged since `10321da` (only `qa-evidence-TOG-4858.md`
  added in between: `git diff 10321da..HEAD --stat` shows 1 file, +91).
- `npm test` re-run: **14 pass, 0 fail, exit 0** (~355ms, node v24.21.0). Verdict below re-confirmed.
- Key citations re-checked (`test/eligibility-matrix.test.js` 123 lines,
  stale rows at `:57-67`; `test/validate-catalog-entry.test.js` 45 lines;
  `src/validate-catalog-entry.js` 70 lines;
  `schema/catalog-entry/v1.json` 244 lines): accurate.

## Prior runs (history)

- Run `6e55da2c-6c42-4517-9ee3-eb43274586d3`: head `10321da`, 14 pass / 0 fail (~374ms).
- Run `725c2c2d-eecf-45d7-a82c-8862a0a94a58`: same head, 14 pass / 0 fail (~364ms).
- Run `b3ea7581-7573-4f17-b47b-8b895e435c0f`: same head, 14 pass / 0 fail (~327ms).
- Run `d3aa1a8a-cb8e-4fcb-8a0e-aedcd82f1408`: same head, 14 pass / 0 fail (~334ms).
- Run `65b78681-ae34-4304-b306-c8256f05847a`: head `e25fc88` (code unchanged since `10321da`), 14 pass / 0 fail (~353ms); upload + PATCH failed (503 then 409 indeterminate).
- Run `927f432e-43e0-4ac9-8674-7658a78732c7`: head `150e2f7` (code unchanged; only evidence file added), 14 pass / 0 fail; read probe 409 indeterminate, no writes attempted per bounded-retry.

## Result

| Suite | Result |
|---|---|
| eligibility matrix (`test/eligibility-matrix.test.js`) - 10 tests, incl. 2 stale-catalog-fail-closed rows | 10/10 pass |
| catalog-entry validation, TOG-4830 (`test/validate-catalog-entry.test.js`) - 4 tests | 4/4 pass |
| **Total** | **14 pass, 0 fail** |

## Acceptance check

- Script runs green: YES (`npm test` exit 0, 14 pass / 0 fail).
- Covers stale-catalog fail-closed case: YES, twice -
  `test/eligibility-matrix.test.js:57-61` (stale `schemaVersion: "v0"` -> `stale-catalog-fail-closed`) and
  `test/eligibility-matrix.test.js:62-67` (missing `schemaVersion` -> `stale-catalog-fail-closed`),
  plus guard `test/eligibility-matrix.test.js:89-94` (matrix must keep >=1 stale row),
  `test/eligibility-matrix.test.js:109-115` (no rejected entry classifies eligible),
  `test/eligibility-matrix.test.js:117-122` (every rejection carries `source=` + `fetchedAt=` provenance).
- Anchored to TOG-4830 schema: YES - classifier imports `SCHEMA_VERSION` / `validateCatalogEntry`
  from `src/validate-catalog-entry.js:1-70`, which enforces `schema/catalog-entry/v1.json:1-244`
  (`additionalProperties: false` at every level, `schemaVersion` const `v1`).

## Matrix rows (7)

1. well-formed v1 entry -> eligible (`test/eligibility-matrix.test.js:43-49`)
2. malformed entry -> ineligible (`test/eligibility-matrix.test.js:50-55`)
3. stale schemaVersion (v0) -> stale-catalog-fail-closed (`test/eligibility-matrix.test.js:57-61`)
4. missing schemaVersion -> stale-catalog-fail-closed (`test/eligibility-matrix.test.js:62-67`)
5. unauthorized unknown fields -> ineligible (`test/eligibility-matrix.test.js:68-73`)
6. null entry -> ineligible (`test/eligibility-matrix.test.js:74-79`)
7. array entry -> ineligible (`test/eligibility-matrix.test.js:80-85`)

## Verdict

`QA 150e2f7ae25862795ee3419584fc524c1bb71823: PASS` (local — registration pending)

## Control-plane registration (run `f23e7598`, 2026-09-26T11:36-11:48Z) - DEGRADED (attempted per board-continue)

Board-resume `continue` required a disposition this run; all control-plane writes attempted
via run-scoped bridge (`PAPERCLIP_API_URL` loopback, 10s worker timeouts):

- Read probe `GET heartbeat-context`: 1x409 `outcome: indeterminate` (bridge timeout). Same as runs `65b78681`, `927f432e`.
- Evidence upload (`paperclip-upload-artifact.sh qa-evidence-TOG-4858.md`, isolated state dir
  `.paperclip-runtime/upload-state` to dodge cross-run `/tmp` lock owned by `pcworker1`):
  attempt 1 -> 409 `outcome: indeterminate`; attempt 2 -> 409 `outcome: indeterminate`.
  Retries stopped per bounded-write rule (2 consecutive failures, same write).
- Disposition PATCH (`in_progress` + verdict comment + `executionPolicy.monitor`
  `nextCheckAt 2026-09-26T12:30:00Z`, `kind external_service`, `serviceName paperclip-bridge`,
  `externalRef TOG-4858-qa-reregister-f23e7598`, `timeoutAt 2026-09-27T12:30:00Z`, `maxAttempts 3`;
  payload at `.paperclip-runtime/upload-state/patch-body.json`):
  attempt 1 (validation) -> 400 `kind` must be `external_service` (fixed);
  attempt 2 (bridge) -> 409 `outcome: indeterminate`, `retryable: false`. NOT retried further:
  server marked it non-retryable and indeterminate may have committed — retry risks a duplicate
  verdict comment.
- **Disposition NOT confirmed; evidence NOT registered; monitor NOT confirmed.** `PATCH` response
  was an error body, not issue JSON, so `monitorNextCheckAt`/`assigneeAgentId`/`status` could not
  be verified. This file (committed locally) plus the adapter/runtime status channel are the
  fallback record.

## Control-plane registration (run `65b78681`, 2026-09-26T10:32Z) - DEGRADED

Bridge still degraded (run-scoped `PAPERCLIP_API_URL`, 10s worker timeouts):

- Evidence upload (`paperclip-upload-artifact.sh qa-evidence-TOG-4858.md`, workspace-local state dir):
  attempt 1 -> 503 `Sandbox callback bridge ... timed out after 10000ms`.
  attempt 2 (after 20s) -> 409 `outcome: indeterminate`, `retryable: false`.
  Retries stopped per bounded-write rule (2 consecutive failures, same write).
- Disposition PATCH (`in_progress` + verdict comment + `executionPolicy.monitor`
  `nextCheckAt 2026-09-26T11:15:00Z`; payload at `.paperclip-runtime/scratch/patch.json`):
  attempt 1 -> 409 `outcome: indeterminate`, `retryable: false`. NOT retried: server marked
  it non-retryable, and this very monitor wake firing suggests indeterminate writes may commit -
  retry risks a duplicate verdict comment.
- **Disposition NOT confirmed; evidence NOT registered; monitor NOT confirmed.** Third consecutive run
  on this card ending without confirmed disposition due to the same bridge error (runs `725c2c2d`,
  `6e55da2c`). Per TOG-4712 pilot rule: status, blockers and monitor left as they are, nothing posted
  to the thread. Manager notified once via run report; then stop. This file (committed locally) plus
  the adapter/runtime status channel are the fallback record.

## What could NOT be verified / done by QA

- Merge NOT done: `Done = merged for code; green-unmerged is not done.` No `main` ref exists locally,
  GitHub broker reports `broker_transport_unavailable`, so push/PR/CI cannot be verified from here.
  Merging is not QA's job; hand off to engineering with Code Reviewer review of the exact head SHA + green CI before merge.
- Code Reviewer approval on the head SHA NOT verified here (out of QA scope per mission).

## Next action (owner / engineering)

1. Register this file as attachment + `artifact` work product on TOG-4858 (attempted this run - see above).
2. Engineering: PR branch -> main, Code Reviewer reviews exact head SHA, CI green, then merge.
3. Then mark TOG-4858 `done` (merged + evidence registered). Do NOT mark `done` on green-unmerged alone.
