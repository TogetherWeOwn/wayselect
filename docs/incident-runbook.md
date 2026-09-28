# Wayselect production incident runbook (TOG-8334)

> **Runbook only — no production activation, no paid services.** Staging
> rollback below is executable today. Production has no host, DNS, TLS,
> secrets manager, or traffic cutover (see `docs/deployment-runbook.md`
> §5), so the production section defines steps, owners, and approvers
> without activating anything. Every command, file, and section number
> cited here was verified against `origin/main` on 2026-09-28; the
> reviewer walk in §7 checks each one against
> `docs/deployment-runbook.md`.

## 1. Roles: owner and approver per step

No `CODEOWNERS` file and no alert wiring (no Slack/email/issue hooks in
`.github/` or `docs/`) exist in this repo, so nobody is paged today —
this table assigns ownership explicitly.

| Step | Owner (does the work) | Approver (signs off) |
| --- | --- | --- |
| Detect + triage (§2–§3) | On-call engineer; backup: Automation Engineer | Director of Engineering |
| Staging rollback (§4) | On-call engineer | Director of Engineering |
| Production rollback (§5, dormant) | Director of Engineering | CEO — do not execute without written approval; prod activation itself is out of scope |
| Code fix after rollback | Director of Engineering / Founding Engineer | Approving reviewer merges per `CONTRIBUTING.md` review rules (reviewer ≠ author, exact head SHA, CI green) |
| Anything touching auth/sessions, secrets, permissions, payments, or public exposure | CISO looped in before any fix merges (`CONTRIBUTING.md`) | CISO |

Repo rules still apply: red CI first — no review on a red PR, and if
`main` is red, fixing `main` comes before any other work.

## 2. Detect: health-check commands

Run in order. All probes are stdlib-only, fixture-only, no credentials.

1. Liveness — `GET /healthz` answers before rate limiting and regardless
   of `WAYSELECT_PREVIEW` (`web/server.js:442`):

   ```sh
   curl -fsS <base-url>/healthz
   ```

   Expected: `200 {"status":"ok","version":"…"}` (`web/server.js:445`).
   Anything else (connection refused, non-200, 404 from a wrong path —
   note the path is exactly `/healthz`, no trailing slash) means the
   process or container is down, not that preview is off.

2. Staging content probe:

   ```sh
   node bin/check-preview-health --base-url <staging-url>
   ```

   (`npm run preview:health` runs the same script locally.) Exit 0 =
   every check passed (skips allowed); 1 = failure; 2 = usage error.
   Asserts the listing index, one detail page, the unknown-listing 404,
   the purchase-stub 403 guard (preview still cannot write), and
   catalog-index freshness. This is the same probe
   `docs/deployment-runbook.md` §2 uses for post-deploy verification.

3. Full staging smoke (health + buyer path + gateway 401/dry-run):

   ```sh
   node bin/smoke-wayselect-staging-preview --base-url <staging-url>
   # or: WAYSELECT_STAGING_URL=<staging-url> npm run smoke:staging-preview
   ```

   Exit codes 0/1/2 as above; budget under 15 minutes. With no
   `--base-url` the script probes an ephemeral local server instead —
   that proves the tree, not staging, so always pass the staging URL
   during an incident.

4. CI signal — is `main` itself red?

   ```sh
   gh run list --repo TogetherWeOwn/wayselect -w ci.yml --limit 5
   gh run view <run-id> --repo TogetherWeOwn/wayselect --log-failed
   ```

   Cron-specific triage (the `17 6 * * *` schedule, `ingestion-smoke`
   job) lives in `docs/ingestion-smoke-triage-runbook.md` — use it
   instead of this doc when only the nightly smoke is red.

## 3. Triage: code, env, or platform?

Decide before rolling back — rollback fixes bad code tags, not bad env
or a dead platform. (`docs/deployment-runbook.md` §4 makes the same
split.)

```sh
git log --oneline -3 origin/main          # what shipped recently?
npm ci && npm run smoke                   # does the tree pass locally? expect smoke: 7/7 passed
npm run pre-push                          # expect: SUMMARY: 8 pass, 0 fail — pre-push READY
```

- Local green + staging red → suspect env drift or platform: compare
  the staging env against the three-variable contract
  (`docs/deployment-runbook.md` §3: `PORT`, `HOST`,
  `WAYSELECT_PREVIEW` only; never set `WAYSELECT_STAGING_ENDPOINT`
  or `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` on a deployment — full
  matrix in `docs/wayselect-env-var-matrix.md`).
- Local red → the tree is broken: roll staging back (§4), then fix
  `main` first per the red-CI rule.
- Both green but `/healthz` down → platform/container: restart the
  container on the current tag, probe §2.1, escalate to the
  Director of Engineering if it stays down.

## 4. Staging rollback (executable)

Mirrors `docs/deployment-runbook.md` §4. No database, no volumes, no
migrations — rollback is stateless: stop the bad container, start the
previous tag, probe green.

1. Identify the last good tag: the deploy log records
   `<image>:<git-sha>` per deploy; cross-check with
   `git log --oneline -3` on `main`.
2. Redeploy the previous tag with the **same** env (`PORT`, `HOST`,
   `WAYSELECT_PREVIEW`) — never change code and env in one step.
   Pin the previous image digest explicitly; verify with the probe
   either way rather than trusting a platform rollback button.
3. Verify: `node bin/check-preview-health --base-url <staging-url>`
   must exit 0, and the purchase-stub 403 `preview_only` guard must
   pass — it proves the rolled-back build still cannot write.
4. If the bad deploy changed env rather than code, restore the
   previous env first and re-run the probe before touching the image
   tag.

Owner: on-call engineer. Approver: Director of Engineering. Record the
tag rolled back from/to and the probe result on the incident card.

## 5. Production rollback (defined, dormant — do not execute)

Production is not activated: no prod host, DNS, TLS, secrets manager,
or traffic cutover exists (`docs/deployment-runbook.md` §5). These
steps take effect only after a production target is defined and approved:

1. Same four steps as §4 against the prod target: last-good tag from
   the prod deploy log, same-env redeploy, probe green including the
   403 guard, env-before-image on env-caused incidents.
2. Extra gates vs staging: CEO written approval before any prod
   redeploy; CISO sign-off when the incident or fix touches
   auth/sessions, secrets, permissions, payments, or public exposure;
   re-evaluate trusted-proxy handling (`web/rate-limit.js`, and the
   explicit non-goal in `docs/deployment-runbook.md` §5) before
   sending any public traffic.
3. Do not improvise a prod target (no ad-hoc host, tunnel, or DNS
   cutover) — standing up prod is a separate approved scope, not an
   incident action.

Owner: Director of Engineering. Approver: CEO.

## 6. After rollback

- File a bug card with: incident time, bad tag/SHA, last-good tag,
  which probe failed and its output excerpt, triage result (§3), and
  the rollback probe evidence. One Code Reviewer pass per fix
  (`CONTRIBUTING.md`: docs/test-only changes need a single pass;
  the approving reviewer merges on a green exact head SHA).
- Do not roll forward (re-ship the reverted change) until the fix PR
  is merged with green CI on its head SHA.

## 7. Reviewer walk (acceptance, under 10 minutes)

Walk this doc against `docs/deployment-runbook.md` and confirm no
dangling references:

1. §1 table — `CODEOWNERS` absent (`ls CODEOWNERS` fails);
   `CONTRIBUTING.md` "Review and merge" carries the one-review,
   reviewer-merges, red-CI-first rules cited.
2. §2.1 — `GET /healthz` at `web/server.js:442`, body at `:445`.
3. §2.2–§2.3 — `bin/check-preview-health` (`npm run preview:health`)
   and `bin/smoke-wayselect-staging-preview`
   (`npm run smoke:staging-preview`, `WAYSELECT_STAGING_URL`
   supported); exit codes 0/1/2 per each script header.
4. §2.4 — `.github/workflows/ci.yml` carries the `test` and
   `ingestion-smoke` jobs; cron triage pointer resolves to
   `docs/ingestion-smoke-triage-runbook.md`.
5. §3 — env contract matches `docs/deployment-runbook.md` §3 (three
   variables; `WAYSELECT_STAGING_ENDPOINT` and
   `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` explicitly not server config);
   matrix details resolve to `docs/wayselect-env-var-matrix.md`.
6. §4 — steps 1–4 match `docs/deployment-runbook.md` §4 verbatim in
   substance (last-good tag, same env, probe + 403 guard,
   env-before-image).
7. §5 — non-activation matches `docs/deployment-runbook.md` §5
   (no prod host/DNS/TLS/secrets/cutover; trusted-proxy non-goal,
   `web/rate-limit.js`).

If steps 1–7 resolve with the evidence shown, the runbook passes.
