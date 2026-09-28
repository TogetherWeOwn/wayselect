# Nightly ingestion-smoke failure-triage runbook (TOG-6042)

Covers the nightly ingestion smoke: schedule `17 6 * * *` in
`.github/workflows/ci.yml` (lines 6-8, comment cites TOG-5246), job
`ingestion-smoke` (lines 28-38) runs `npm run smoke`
(`node bin/smoke-wayselect-ingestion`). Fixture-only, no network, no
credentials, no spend. The script runs 7 checks and exits 0 only when
every check passes; the tail line reads `smoke: 7/7 passed`.

Closes gap G5/O1 from the [TOG-6013](/TOG/issues/TOG-6013) gap-list doc:
the cron had no written triage path (who looks, where).

## 1. Where the cron result surfaces

There is no Slack, email, or issue notification on failure (verified
2026-09-27: no notify/webhook wiring in `.github/` or `docs/`). The
result lives in one place:

- GitHub Actions > TogetherWeOwn/wayselect > `ci` workflow > runs with
  event `schedule` (fires 06:17 UTC daily).

Find it with:

```sh
gh run list --repo TogetherWeOwn/wayselect -w ci.yml -e schedule --limit 5
```

Acceptance anchor (latest green cron run at time of writing):

- Run `36317890727` — `schedule`, `success`, `main`, created
  `2026-09-27T12:06:29Z`, head SHA `bdfbca9beeb10cbf3ae1efdd3ef5c231550886f6`.
  Jobs: `test` (108615951246) success, `ingestion-smoke`
  (108615951446) success.
  URL: `https://github.com/TogetherWeOwn/wayselect/actions/runs/36317890727`

Note: push/PR runs of the same `ci` workflow carry the identical
`ingestion-smoke` job (for example run `36358885390` on `main` @
`0dc5858`, job `ingestion-smoke` 108731963970, 13s, success). Use a
`schedule`-event run to prove the cron path; use a push run only as a
secondary log sample.

## 2. Who triages

Verified repo facts: there is no `CODEOWNERS` file and no alert routing
(no Slack/email/issue wiring in `.github/` or `docs/`), so nobody is
paged today — this section assigns ownership explicitly:

- Primary: Director of Engineering (author of the round-2 ship backlog
  that filed this gap). Backup for cron health: Automation Engineer,
  who picks up an untriaged red schedule run by 09:00 UTC.
- Code fix needed: hand to Director of Engineering / Founding Engineer.
- Failure touches auth, secrets, permissions, payments, or public
  exposure: loop in CISO before merging any fix (CONTRIBUTING.md
  review rule).
- Repo rules still apply (CONTRIBUTING.md): red CI first — no review
  on a red PR, and if `main` is red, fixing `main` comes before any
  other work in the repo.

## 3. First 5 diagnostic commands (in order)

Run from a clean checkout of `TogetherWeOwn/wayselect` at the cron's
head SHA (`gh run view` reports it). All five were verified 2026-09-27.

1. List the recent cron runs and pick the red one:

   ```sh
   gh run list --repo TogetherWeOwn/wayselect -w ci.yml -e schedule --limit 5
   ```

   Expected: table with run id, conclusion, head SHA, created time.
   Green anchor shows `success` for run `36317890727`.

2. Confirm which job failed:

   ```sh
   gh run view <run-id> --repo TogetherWeOwn/wayselect
   ```

   Expected: JOBS table (`test`, `ingestion-smoke`, plus newer jobs
   such as `search-index-probe`, `marker-gate`, `e2e-staging-acceptance`
   on current `main`). A smoke failure shows `ingestion-smoke` as
   failed while the other jobs may still be green.

3. Read the failing step output:

   ```sh
   gh run view <run-id> --repo TogetherWeOwn/wayselect --log-failed
   ```

   Expected on green: empty output, exit 0. On red: the failing
   `Run npm run smoke` (or `Run npm test`) step with `FAIL <check
   name>:` lines. A green smoke log shows the 7 PASS lines ending in
   `smoke: 7/7 passed` (sample pinned from run `36358885390`, job
   `108731963970`):

   ```text
   PASS  ingest: catalog fixture normalizes with provenance — 6 entries from synthetic://wayselect/fixture-v1
   PASS  freshness: fresh snapshot passes the probe — fresh at +2h against a 24h limit
   PASS  fail-closed: stale snapshot refuses routing — no route served past the 24h limit; CatalogStaleError raised
   PASS  schema: catalog-entry validator accepts valid, rejects bad — 1 accepted, 3 rejected with provenance
   PASS  snapshot: content hash is deterministic — sha256:c6cdb62e… stable across builds
   PASS  demo: dry-run CLI selects a route without network — selected northstar/alpha-chat; networkUsed=false
   PASS  demo: stale CLI serves no route and no transport — no-eligible-route with null transport past the 24h limit
   smoke: 7/7 passed
   ```

4. Reproduce locally (fixture-only, no credentials):

   ```sh
   npm ci && npm run smoke
   ```

   Expected on healthy `main`: the same 7 PASS lines and
   `smoke: 7/7 passed` (verified 2026-09-27). If local reproduces the
   CI failure, the bug is in the tree, not in CI.

5. Scope the blast radius:

   ```sh
   npm run pre-push
   ```

   Expected on healthy `main`: `SUMMARY: 5 pass, 0 fail — pre-push
   READY` (verified 2026-09-27: 5 pass, `npm test` 712 pass / 0 fail
   across 82 suites). Smoke-only red plus green suite means the
   failure is isolated to the ingestion boundaries; both red means a
   wider regression.

## 4. Bug card vs re-run

Re-run without a bug card when all of these hold:

- `npm run smoke` passes locally on the cron's head SHA (CI-only
  flake: runner image notice, `npm ci` registry timeout, GitHub
  incident, single-attempt failure with a green retry).
- The retry is green: `gh run rerun <run-id> --failed --repo
  TogetherWeOwn/wayselect`, then the new attempt shows success.
- No tree change is needed; note the re-run URL and the flake reason
  on the tracking card.

File a bug card in the Wayselect project when any of these hold:

- The failure reproduces locally (`npm run smoke` fails on `main`).
- The same check fails two nights in a row, or a re-run stays red.
- The log names a tree file (`fixtures/`, `src/`, `bin/`, snapshot
  hash, provenance timestamp) rather than CI plumbing.
- The failure started right after a merged PR (bisect to that PR).

The bug card carries: cron run URL, head SHA, failed job id, failing
check name plus the `FAIL` log excerpt (not the whole log), local
`npm run smoke` result, and whether `npm test` is also red. One
Code Reviewer pass per fix; the approving reviewer merges on a green
head SHA (reviewer is never the author).

## 5. Reviewer acceptance check (under 10 minutes)

1. `gh run list --repo TogetherWeOwn/wayselect -w ci.yml -e schedule --limit 5` — find run `36317890727`.
2. `gh run view 36317890727 --repo TogetherWeOwn/wayselect` — confirm both jobs success.
3. `gh run view 36317890727 --repo TogetherWeOwn/wayselect --log-failed` — confirm empty (green).
4. `npm ci && npm run smoke` — confirm `smoke: 7/7 passed`.
5. Match the 7 PASS lines against section 3 above.

If steps 1-5 complete with the expected evidence, the runbook passes.
