# Search-prompt eval seed and rerun contract (TOG-6047)

Gap T4 (round-2 gap list, [TOG-6013](/TOG/issues/TOG-6013)): the
search-prompt regression eval ran pinned to a seed nobody documented, so a
reviewer could not tell a correct rerun from a drifted one. This doc pins
the seed, the rerun steps, and the determinism a rerun must reproduce.
Proven by
[`test/search-prompt-eval-seed-rerun.test.js`](../test/search-prompt-eval-seed-rerun.test.js),
which runs on every `npm test`.

## The seed

Documented seed: `5492`

It is the default `--seed` of `bin/eval-wayselect-search-prompts` and the
seed baked into `npm run eval:search-prompts`
(`node bin/eval-wayselect-search-prompts --seed 5492`). Omitting the flag
and passing `--seed 5492` print the same SUMMARY line — the pin test
asserts exactly that, so the doc and the script cannot drift apart
silently.

The seed feeds a mulberry32 shuffle (Fisher-Yates) of the 3 stub listings
for the eval's determinism self-check. It does not move the published
counts: `test/search-prompt-multi-seed.test.js` pins the identical SUMMARY
across one seed per shuffle class (all 6 input orderings, seeds 0–199).

## How to rerun (reviewer steps)

From the repo root. Stdlib only, no network, no credentials:

```sh
node bin/eval-wayselect-search-prompts --seed 5492
```

or equivalently:

```sh
npm run eval:search-prompts
```

Expected: exit `0`, stdout ends with this SUMMARY (the trailing run time
varies; everything before it is pinned):

```text
SUMMARY: before 13/30, mid 24/30, after 30/30, v2-fixed 11, v3-fixed 6, regressed 0 — 0.0s
```

`evals/search-prompt-regression/results.md` records the same outcome plus
content hashes of the four inputs (`queries.json 1a67cdd10010`,
`v1-baseline.md 40a0ecdadde2`, `v2-cue-extraction.md 0a1b7b2bbcc0`,
`v3-negation-scope.md 442f180e630a`). To confirm the flag can be omitted:

```sh
node bin/eval-wayselect-search-prompts | tail -1
```

Expected: the same SUMMARY as the explicit `--seed 5492` run.

## Expected determinism

The eval exits `1` unless its self-check passes for the given seed:

- **Repeatable:** every version (v1, v2, v3) returns identical rankings
  across repeated runs on the same input, for all 30 queries.
- **Shuffle-invariant top-1s (v2/v3, non-blank queries):** ranking the
  seed-shuffled stub order top-1s the same listing as canonical stub order
  (S7 stub-order tie-breaks).
- **Order-dependent by design:** v1 multi-matches (e.g. Q05 `northstar`)
  preserve caller input order — v1 is the shipped S2 pass-through rule, and
  production is reproducible because the server always feeds canonical stub
  order. Blank queries (S3, e.g. Q18) preserve caller order in all
  versions.

`--seed` must be a non-negative integer; anything else exits `1` without
running the eval.

## When the numbers move

Regenerate, never hand-edit:

```sh
node bin/eval-wayselect-search-prompts --seed 5492 --write
```

`--write` rewrites `results.md` (table, SUMMARY, hashes, run time) from the
live ranking code in `support/search-prompts.js`. A moved SUMMARY means the
ranking code or the fixtures changed — update the golden pins in
`test/search-prompt-regression.test.js` and the multi-seed SUMMARY pin in
the same PR, and say why in the PR body. A moved content hash means an
input file changed; that is expected when queries or prompts change, and
suspicious otherwise.

## Hard limits

- Do not change the default seed without updating this doc,
  `package.json` (`eval:search-prompts`), `results.md`, and the pin test
  together. The pin test fails if they drift apart.
- This eval measures; it never gates. Regressions exit `0` (the table shows
  them); only crashes and failed determinism self-checks exit `1`.
