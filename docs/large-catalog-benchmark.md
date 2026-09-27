# Large-catalog benchmark (TOG-6336)

Stress fixture + refresh benchmark budget for [TOG-5735](/TOG/issues/TOG-5735).
Companion to the small-fixture select budget (`test/selection-perf-budget.test.js`, TOG-6036);
this pins the large-input paths instead.

## Fixture

- Generator: `scripts/generate-large-catalog.mjs` (fixed mulberry32 seed `5735`).
- Output: `fixtures/catalog.large-synthetic.json` — 50 providers x 40 models = **2000 routes**.
- Reproducible: re-running the generator is byte-identical. **Never hand-edit** the fixture;
  regenerate with `node scripts/generate-large-catalog.mjs`.
- Source: `synthetic://wayselect/large-fixture-v1`; valid `snapshotHash` via
  `computeCatalogSnapshotHash`, so `normalizeCatalog` verifies.
- Gap mix (by route index): every 10th route omits capability booleans
  (missing-capability), every 10th+1 omits cost (missing-rates), every 10th+2
  omits limits (unknown-limits), every 7th uses image input (vision-chat).

## Stages and budgets

Run: `npm run bench:large-catalog` (prints JSON `{ timings, budget, ok }`; exits 1 over budget).
CI cover: `test/large-catalog-benchmark.test.js` asserts the same budgets via `npm test`.

| Stage | What | Budget | Measured (2026-09-27, local) | Headroom |
|---|---|---|---|---|
| normalize | `normalizeCatalog` over 2000 routes | 250ms | ~13–23ms | ~10x |
| searchIndex | `buildSearchIndex` | 300ms | ~23–26ms | ~10x |
| probe | `probeSearchIndexRefresh` (build+rebuild+reload) | 1000ms | ~70–80ms | ~10x |
| snapshot | `buildSnapshot` x2 (base + 1-added/1-changed delta) | 1000ms | ~44–62ms | ~10x |
| diff | `diffSnapshots` base vs delta | 100ms | ~4–7ms | ~10x |
| total | wall clock, all stages | — | ~159–187ms | — |

Budgets are ~10x the local maxima above: CI timer variance (2–3x) stays green,
while an algorithmic regression trips loudly.

Budget source of truth: `LARGE_CATALOG_BUDGETS_MS` in `bin/benchmark-large-catalog`.
The test imports the same constants — one place to change.

## Runbook (when the budget trips)

1. `npm run bench:large-catalog` — see which stage regressed.
2. Bisect recent `src/catalog.js` / `src/searchIndex.js` / `src/snapshot.js` / `src/catalogDiff.js` changes.
3. Profile that stage on the fixture; fix the regression.
4. Do NOT raise the budget without recording a perf explanation on the card.
