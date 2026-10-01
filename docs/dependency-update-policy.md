# Wayselect dependency-update policy

Owner: **CTO & Chief AI Officer**. Adopted 2026-09-26 (TOG-5057).

## Scope

Everything Wayselect consumes but does not author: npm packages (currently
`ajv` + `ajv-formats` for JSON-schema catalog validation and `escape-html`
for HTML-escaping rendered output; exact versions in `package.json`, no
ranges), GitHub Actions used in CI, and the Node.js version pinned in CI.
Fixture data under `fixtures/` is synthetic and in-repo; it is not a
third-party dependency.

## Cadence

- **Monthly check, first week of each month.** The owner (or delegate) reviews
  outstanding updates and lands one policy-conformant PR per cycle, or records
  "no updates due" on the tracking card.
- **Security advisories out of band:** triage within 24h for critical/RCE-type
  advisories, 7 days otherwise — same fix path, expedited review.
- Seven-day metric: policy adopted; next update on schedule.

## Pinning rules

- **GitHub Actions are SHA-pinned** with the floating tag kept as a trailing
  comment for readability, e.g. `uses: actions/checkout@<sha> # v4`.
  Dependabot-style floating tags (`@v4`) alone are not accepted.
- **If npm dependencies are ever added:** exact versions in `package.json`
  (no `^`/`~` ranges) plus a committed `package-lock.json`. `npm ci` must
  reproduce the tree.
- **Node version:** CI pins a major (`node-version: 20`) matching the
  `engines` field in `package.json`. Major bumps are deliberate PRs, not
  drive-bys.
- No new network access: Wayselect's demo runs offline on stdlib; an update
  that introduces runtime network calls or credentials is out of scope and
  needs a separate security decision.

## Security-advisory handling

Fail closed, consistent with the eligibility rules in `src/eligibility.js`:

1. Assess: does the advisory affect our pinned versions / exercised code paths?
2. If yes: patch or pin-forward promptly (24h critical / 7d other), with tests.
3. If no: record the no-op assessment on the tracking card; no churn PRs.
4. Never bypass red CI or merge with known-exploited versions in the tree.

## Automation (TOG-6386)

`.github/dependabot.yml` opens the monthly update PRs behind this policy —
npm (minor+patch grouped, majors separate) plus GitHub Actions, free tier.
Dependabot never merges: every PR lands via human review as a
policy-conformant PR (exact npm pins + lockfile; action refs converted to
`@<sha> # <tag>` SHA-pin form before merge — never merge a floating tag).
Dependabot cannot schedule day-of-month, so the "first week" review stays a
human step on the tracking card.

## First policy-conformant update (TOG-5057, 2026-09-26)

- Pinned `ajv` at `8.20.0`, `ajv-formats` at `3.0.1`, and `escape-html` at
  `1.0.3` (exact versions, no `^`/`~` ranges) and regenerated
  `package-lock.json` (`npm install --package-lock-only`; audit clean, 0
  vulnerabilities). This is the first policy-conformant update: the repo
  previously carried floating `^` ranges on the ajv packages.
- `npm test` green (185 pass across 18 suites); catalog-validation behavior
  (fail-closed v1 entry checks) unchanged.
- Known follow-up (not in this PR): SHA-pin `actions/checkout@v4` →
  `@11d5960a326750d5838078e36cf38b85af677262 # v4` and
  `actions/setup-node@v4` → `@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4`
  (v4 tips as of 2026-09-26). Blocked in this run: the GitHub App token
  refuses workflow-file pushes without `workflows` permission, so the pin must
  land via a principal holding that scope.

## Reviewer verification

1. `git diff main --stat` shows only `docs/dependency-update-policy.md`,
   `package.json` (exact pins) and `package-lock.json` (the SHA-pin
   follow-up lands separately).
2. `npm test` passes locally and on the PR's CI run (185 pass).
3. `package.json` lists `ajv`/`ajv-formats`/`escape-html` with exact
   versions (no ranges); `npm ci` reproduces the tree.
