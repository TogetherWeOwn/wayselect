# Wayselect eligibility-explain acceptance: fail-closed paths (TOG-5220)

Independent QA leaf on the current Wayselect CLI. Pairs
[TOG-4794](/TOG/issues/TOG-4794) (richer typed capability requirements) but
does **not** block on it: everything below runs against the current tree, and
the script re-checks cleanly once TOG-4794 lands (see G3).

Non-goals (inherited): no live provider calls, no credentials, no network
access, no backend writes. All prices are synthetic list-price estimates. The
only transport is the in-memory fake adapter (`networkUsed: false`).

## 1. Baseline contract (golden path, must stay green)

| # | Request | Expected |
| --- | --- | --- |
| E0 | `node bin/wayselect` (default fixtures) | exit 0, empty stderr, `mode=dry-run-only`, `selection.dryRun=true` |
| E0 | same | `status=selected`, `selected.routeId=northstar/alpha-chat` (lowest synthetic rate, lexicographic tie-break) |
| E0 | same | `transport={adapter:fake, networkUsed:false}`; `orbit/orbit-chat` also eligible (loses tie-break); `legacy/old-chat` carries `stale-evidence` |

## 2. Fail-closed contract (unknown / blocked inputs never select)

| # | Request | Expected |
| --- | --- | --- |
| E1 | `requiredCapabilities=["unpublishedCapability"]` | `no-eligible-route`, `selected=null`, `transport=null`, every candidate explains `missing-capability:unpublishedCapability` (never guessed) |
| E2 | `providerAllowlist=["nobody"]` | `no-eligible-route`, every candidate explains `provider-not-allowed` |
| E3 | `operation="embeddings"` | `no-eligible-route`, every candidate explains `operation-not-catalogued` + `operation-not-configured` |
| E4 | `providerAllowlist=[]` | nonzero exit, stderr names the explicit-value rule (empty is never allow-all) |
| E5 | default fixtures | `northstar/unknown-tools` ineligible with exactly `["missing-capability:toolUse"]` (missing data, not a guess) |
| E6 | `evaluationTime` past snapshot+24h | `no-eligible-route`, every candidate explains `stale-catalog` |
| E7 | `evaluationTime` before snapshot timestamp | `no-eligible-route`, every candidate explains `future-catalog` |
| E9 | default fixtures | `northstar/image-lite` (`tool_call=false`) explains `unsupported-capability:toolUse` (distinct from missing); `orbit/retired-chat` explains `support-state:unsupported` |

## 3. `--dry-run` contract (implicit-only mode)

`bin/wayselect` exposes **no** `--dry-run` flag: dry-run is the only mode.

| # | Request | Expected |
| --- | --- | --- |
| E8 | `node bin/wayselect --dry-run` | nonzero exit, stderr names the unknown flag |
| E0b/c | `node bin/wayselect` | `mode=dry-run-only` and `selection.dryRun=true` instead of a flag |

## 4. Runnable acceptance script (under 15 minutes)

```sh
node --version                # 20+
npm run accept:eligibility    # this acceptance script, typically < 1s
npm test                      # regression: full suite still green
```

`bin/accept-wayselect-eligibility` (zero dependencies, stdlib only) runs the
real CLI from `bin/wayselect` with fixture-only inputs (overrides staged in
`$TMPDIR`, never written to the repo) and checks §1–§3. Expected tail output
today:

```
SUMMARY: 32 pass, 0 fail — 0.2s (budget 15m)
```

Exit code is 0 with zero failures, 1 otherwise. No skips by design: every
check runs against the current tree.

QA end-to-end (reviewer-checkable, no setup beyond a clean checkout):

1. `node --version` → 20+ (else FAIL).
2. `npm ci && npm run accept:eligibility` → exit 0, note pass/fail counts.
3. `npm test` → exit 0, 80+ pass, 0 fail (no regression).
4. Report: paste the `SUMMARY:` line plus any `FAIL` lines as the pass/fail
   record. Any FAIL is a rejection; file it as a named follow-up.

## 5. Sign-off, metric, kill/scale

- [ ] Engineer: script executes end-to-end in under 15 minutes on a clean checkout.
- [ ] QA: pass/fail semantics independently reproducible (`npm run accept:eligibility`).
- [ ] Code Reviewer: one pass on the script + doc (test-script-only change).

Seven-day metric (by 2026-10-03): script executed 0-fail against the current
tree — 1 accepted script. Kill rule: if the CLI gains a `--dry-run` flag or
TOG-4794 changes reason codes, update §2–§3 rows in place rather than forking
the script. Scale rule: once TOG-4794 lands,
`npm run accept:eligibility` becomes a required gate for every subsequent
eligibility slice. Review date: 2026-10-03.

## 6. Accepted gaps

- G1: no explicit `--dry-run` flag; dry-run is the implicit only mode.
  Accepted: E0b/c assert the mode fields and E8 pins the rejection, so a
  future flag addition fails loudly here instead of silently changing meaning.
- G2: request overrides are staged in `$TMPDIR` per run. Accepted: no repo
  writes, no fixture drift; tmp dirs are removed after each check.
- G3: TOG-4794's richer typed requirements (modalities, context window,
  token limits) are not yet in the CLI, so §2 covers the current normalized
  capability names only. Accepted: re-run this script after TOG-4794 merges;
  new reason codes extend §2 in place.
