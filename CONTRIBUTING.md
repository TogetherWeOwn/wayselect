# Contributing to Wayselect

> **Early development — fixture-only, dry-run only.** No live routing, no live
> model calls, no credentials, no endpoint discovery. See `README.md`
> ("What Wayselect is / is not") before contributing.

This file collects the contributor conventions that previously lived only in
review threads. Follow it so small slices stay reviewable and mergeable.

## Setup (clean checkout)

```sh
git clone https://github.com/TogetherWeOwn/wayselect && cd wayselect
node --version   # 20+
npm ci           # required before npm test — the suite uses pinned packages
npm test
npm run demo
```

Full CLI reference: `docs/cli.md`. Acceptance specs and contracts: `docs/`
(indexed in `README.md` under "Docs index").

## Ground rules (non-negotiable)

- **Tests stay offline.** The suite runs `node --test` with pinned packages
  only. The `transport` test fails if `fetch` is called; server tests bind an
  ephemeral port and talk to it over `localhost`/`127.0.0.1`; probe tests run
  the CLI against saved local input. `--fetch` (the only networked path) is
  never exercised in tests. Do not add tests that reach the live network.
- **Fixtures are synthetic and checked in.** Add or edit `fixtures/` files as
  data; refresh stamped provenance through `bin/refresh-catalog-fixtures`,
  never by hand-editing. Re-run refreshes must be byte-identical no-ops when
  the timestamp is unchanged.
- **Fail closed, never guess.** Unknown fields are rejected at the
  `src/catalog.js` boundary; missing capability data is reported with an
  explicit reason code, never inferred.
- **Claims discipline.** Keep README/docs claims accurate to merged behavior
  only — no compatibility, cost, or savings language. Catalog presence
  (`catalogued`) is not support, permission, configuration, conformance, or
  availability.
- **Boundaries.** Node 20+ ESM; keep `bin/wayselect` thin and `src/`
  boundaries intact. No new runtime dependencies without a CTO note
  (see `docs/dependency-update-policy.md` for pinning rules).

## Branch, commit, PR

- **Branch:** `TOG-<id>-<slug>` (e.g. `TOG-6388-wayselect-contributing`),
  branched from `main`.
- **Commits:** subject format `TOG-<id>: <what changed>` (e.g.
  `TOG-6388: add CONTRIBUTING.md`). Push your working branch to `origin`
  after each commit so work is never local-only.
- **PR body:** what changed, how it was verified (commands + pass/fail
  counts), and `Closes TOG-<id>.` One PR per card — one reviewable slice.
  The PR template (`.github/pull_request_template.md`) reminds you to use a
  Conventional Commits title (`type(scope): summary`, enforced by `pr-lint`).
- **Issues:** use the bug-report / feature-request templates
  (`.github/ISSUE_TEMPLATE/`); blank issues are disabled.
- **CHANGELOG:** every merged PR gets one entry under `## Unreleased`,
  written by the author in the same PR (PR number, TOG id, what changed,
  files touched; docs-only and test-only PRs get entries too). The reviewer
  verifies the entry matches the diff. Full process: `CHANGELOG.md`
  ("Release-note process"). Pin the PR number in the entry once the PR
  exists, before merge.

## Gates before push

Run the same gates CI runs, locally, before pushing:

```sh
npm run pre-push   # expect: SUMMARY: 10 pass, 0 fail — pre-push READY
```

This runs the engine gate, JS-parse, JSON-parse, workflow-parse,
`npm test`, marker gate, smoke + search-index probe, e2e + demo,
large-catalog bench-measurement, and accept-harness gates —
one local gate per CI job, so green pre-push predicts green CI. Optional per-clone hook (never committed):
`cp docs/pre-push-hook.sample .git/hooks/pre-push`. Details:
`docs/pre-push-check.md`. CI itself (`.github/workflows/ci.yml` plus
`.github/workflows/acceptance.yml`) runs `npm test`, the fixture-only
ingestion smoke, the search-index probe, the marker gate, the offline
accept harnesses (`npm run accept:all`), the dependency
audit gate (`npm audit --audit-level=high`, CI-only: it needs the npm
registry), and e2e staging
acceptance on push, PR, and nightly.

## Reason codes and docs that must move together

- A new eligibility reason code means updating `docs/eligibility-reasons.md`
  **and** its guard test in the same PR.
- A new `bin/accept-*` script or operator knob needs a doc pin (env name,
  units, default) so operators can find it without reading source.
- A new `docs/` acceptance spec means adding it to the `README.md`
  "Docs index" in the same PR.

## Review and merge

- **One review per PR.** Fixes after a changes verdict stay on the same
  review; the reviewer re-checks the new head there. No separate re-review
  cards.
- **Docs, specs, test scripts, fixtures, CI-only changes:** one Code Reviewer
  pass. Security/CISO review only when the diff touches auth/sessions,
  secrets, permissions, payments, or public exposure.
- **The approving reviewer merges** (reviewer ≠ author). The review covers
  the exact head SHA that merges, with CI green on it; a re-push after
  approval requires re-review.
- **Red CI first:** no review on a PR with red CI. If `main` is red, fixing
  `main` comes before any other work.

## What stays out of scope

No paid services, no credentials, no model pins, no production activation,
no live transport. Future live-conformance work needs separate provenance,
security, access, and review decisions.

License: MIT — see [LICENSE](LICENSE).
