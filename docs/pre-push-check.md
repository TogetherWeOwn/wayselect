# Local pre-push check (TOG-5049; parity audit TOG-7319)

`bin/pre-push-check` (also `npm run pre-push`) runs the same gates CI runs,
plus local parse checks — before you push. Stdlib only, no new dependencies.

**Scope: content only.** This script and the optional hook below change no
workflow, no branch protection, and no permissions. [TOG-4831](/TOG/issues/TOG-4831)
stays the grant-gated track.

## Install (≤ 5 steps)

1. `node --version` — needs 20+.
2. From the repo root, run the gate once: `npm run pre-push`.
3. Confirm the tail line reads `SUMMARY: 8 pass, 0 fail — pre-push READY`.
4. Optional, local-only: install the hook — `cp docs/pre-push-hook.sample .git/hooks/pre-push && chmod +x .git/hooks/pre-push`.
5. Push normally: `git push`. The hook runs the same script; a failing gate aborts the push before anything leaves your machine.

Steps 1–3 are the required path (reviewer can run it); step 4 is opt-in per clone and is never committed.

## What the script checks

One gate per CI job in `.github/workflows/ci.yml`, plus the acceptance
workflow's local steps — a green pre-push predicts a green CI:

| Step | Gate | CI job it mirrors | How |
| --- | --- | --- | --- |
| P1 | Engine gate | `test`, `ingestion-smoke` (`node bin/check-node-engines`) | Runs the exact CI step |
| P2 | JS parses | `test` (`npm test` needs every file to load) | `node --check` over `src/`, `test/`, `web/`, `support/`, `scripts/`, `evals/` (`*.js` + `*.mjs`, recursive) and every `node`-shebang entry in `bin/` |
| P3 | JSON parses | `test`, `ingestion-smoke` (fixture/schema loads) | `JSON.parse` over every tracked `*.json` (package, `fixtures/`, `schema/`, `test/fixtures/`, `test/golden/`, `snapshots/`, `evals/`, evidence files) |
| P4 | Workflows parse | every job (a broken workflow fails all of CI) | Structural check on every `.github/workflows/*.yml` (tabs, `name:`/`on:`/`jobs:`) + `yaml.safe_load` when python3+pyyaml already exists locally |
| P5 | Tests green | `test` | `npm test` (`node --test` suite) |
| P6 | Marker gate | `marker-gate` | Runs the exact CI step (`node bin/check-no-todo-markers`) |
| P7 | Smoke + index probe | `ingestion-smoke`, `search-index-probe` | Runs the exact CI steps (`npm run smoke`, `npm run check:search-index`) |
| P8 | E2E + demo | `e2e-staging-acceptance`, `acceptance` workflow | `node scripts/e2e-staging-acceptance.mjs` (evidence to a temp dir, repo stays clean) + `npm run demo` |

Exit code is 0 when every step passes, 1 otherwise.

Intentionally not run locally: `npm ci` (CI's clean-install step; the gate
uses the existing `node_modules`) and the acceptance script's clean-clone
mode (`scripts/acceptance.sh <ref>` clones the repo; the gate verifies the
working tree in place, which is what gets pushed).

## Hook behavior

- The sample hook (`docs/pre-push-hook.sample`) calls `node bin/pre-push-check` and aborts the push on failure.
- Hooks live under `.git/hooks/` (untracked by design) — each clone opts in; nothing is enforced repo-wide.
- No secrets, no network, no permission change: the hook runs the same local checks as the script.

## Parity maintenance

`test/pre-push-parity.test.js` pins this mapping offline: every CI job has a
local gate, every workflow file is parsed, `scripts/*.mjs` and the marker
gate are covered. When CI gains a job, add the gate here first — a red
pre-push must stay a strict superset of a red CI.

## Seven-day metric

By 2026-10-03: `bin/pre-push-check` still present and `npm run pre-push` still exits 0 on `main`.
