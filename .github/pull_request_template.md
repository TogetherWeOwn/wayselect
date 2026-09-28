<!-- One PR per card — one reviewable slice. Full conventions: CONTRIBUTING.md. -->

## PR title

<!-- Conventional Commits header (enforced by the `pr-lint` check): `type(scope): summary`, max 100 chars, no trailing period. Types: feat, fix, perf, refactor, test, docs, build, ci, chore, revert, style, security. Example: `fix(auth): refuse expired sessions`. Put the card ID in the body (`Refs:` / `Closes TOG-____` below), never in the title. Squash-merge only: the PR title becomes the single commit on main. -->

- [ ] Title is a Conventional Commits header, ≤ 100 chars, no trailing period

## What changed

-
- Closes TOG-____.

## How it was verified

<!-- CI must be green before review (red CI first: no review on a red PR). Paste commands + pass/fail counts. -->

- [ ] `npm run pre-push` — SUMMARY: __ pass, __ fail (expect 9 pass, 0 fail)
- [ ] `npm test` — __ pass, __ fail
- [ ] Fixtures touched? `npm run accept:fixture-refresh` + `npm run check:drift` — yes / n/a

## CHANGELOG

<!-- Every merged PR gets one entry under `## Unreleased`: PR number, TOG id, what changed, files touched. Docs-only and test-only PRs get entries too. Pin the PR number once it exists. -->

- [ ] Entry added under `## Unreleased`

## Review

<!-- One review per PR — fixes stay on the same review; a re-push needs re-review of the new head. The approving reviewer merges (reviewer ≠ author). -->

- [ ] Reviewer: __ ; head SHA reviewed: __
