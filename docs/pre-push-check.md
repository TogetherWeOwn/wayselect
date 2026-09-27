# Local pre-push check (TOG-5049)

`bin/pre-push-check` (also `npm run pre-push`) runs the same gates CI runs,
plus local parse checks — before you push. Stdlib only, no new dependencies.

**Scope: content only.** This script and the optional hook below change no
workflow, no branch protection, and no permissions. [TOG-4831](/TOG/issues/TOG-4831)
stays the grant-gated track.

## Install (≤ 5 steps)

1. `node --version` — needs 20+.
2. From the repo root, run the gate once: `npm run pre-push`.
3. Confirm the tail line reads `SUMMARY: 5 pass, 0 fail — pre-push READY`.
4. Optional, local-only: install the hook — `cp docs/pre-push-hook.sample .git/hooks/pre-push && chmod +x .git/hooks/pre-push`.
5. Push normally: `git push`. The hook runs the same script; a failing gate aborts the push before anything leaves your machine.

Steps 1–3 are the required path (reviewer can run it); step 4 is opt-in per clone and is never committed.

## What the script checks

| Step | Gate | How |
| --- | --- | --- |
| P1 | Node ≥ 20 | `process.version` vs `package.json` engines |
| P2 | JS parses | `node --check` over `src/`, `test/`, `web/`, `support/`, `bin/` |
| P3 | JSON parses | `JSON.parse` over `package.json` + `fixtures/*.json` |
| P4 | CI workflow parses | Structural check on `.github/workflows/ci.yml` (tabs, `name:`/`on:`/`jobs:`) + `yaml.safe_load` when python3+pyyaml already exists locally |
| P5 | Tests green | `npm test` (`node --test` suite) |

Exit code is 0 when every step passes, 1 otherwise.

## Hook behavior

- The sample hook (`docs/pre-push-hook.sample`) calls `node bin/pre-push-check` and aborts the push on failure.
- Hooks live under `.git/hooks/` (untracked by design) — each clone opts in; nothing is enforced repo-wide.
- No secrets, no network, no permission change: the hook runs the same local checks as the script.

## Seven-day metric

By 2026-10-03: `bin/pre-push-check` still present and `npm run pre-push` still exits 0 on `main`.
