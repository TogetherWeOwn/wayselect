<!-- One PR per card — one reviewable slice. Full conventions: CONTRIBUTING.md. -->

## What changed

-
- Closes TOG-____.

## How it was verified

<!-- CI must be green before review (red CI first: no review on a red PR). Paste commands + pass/fail counts. -->

- [ ] `npm run pre-push` — SUMMARY: __ pass, __ fail (expect 5 pass, 0 fail)
- [ ] `npm test` — __ pass, __ fail
- [ ] Fixtures touched? `npm run accept:fixture-refresh` + `npm run check:drift` — yes / n/a

## CHANGELOG

<!-- Every merged PR gets one entry under `## Unreleased`: PR number, TOG id, what changed, files touched. Docs-only and test-only PRs get entries too. Pin the PR number once it exists. -->

- [ ] Entry added under `## Unreleased`

## Review

<!-- One review per PR — fixes stay on the same review; a re-push needs re-review of the new head. The approving reviewer merges (reviewer ≠ author). -->

- [ ] Reviewer: __ ; head SHA reviewed: __
