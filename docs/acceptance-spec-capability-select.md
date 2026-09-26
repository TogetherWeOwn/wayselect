# Wayselect next-feature acceptance spec — capability-aware dry-run select (v1)

Status: proposed for CEO approval · CPO-owned requirements · 2026-09-26
Goal: [Agent-Run Revenue, Zero Owner Hours](/TOG/goals/f9e0ab30-bf0c-4b1f-af7e-943210ec80c7) — smallest sellable improvement after catalog schema + dry-run explain.

## 1. Context

After [TOG-4830](/TOG/issues/TOG-4830) (catalog-entry JSON schema, fail-closed validation) and
[TOG-4836](/TOG/issues/TOG-4836) (CLI `--dry-run` eligibility explain), the catalog can be trusted
and decisions can be inspected. The next sellable step is making `select` actually capability-aware:
filter by typed requirements, rank, and explain — still dry-run only. This spec tightens the existing
blocked slice [TOG-4794](/TOG/issues/TOG-4794) into acceptance-testable requirements so engineers can
slice it without further product questions.

## 2. User story

As a developer choosing a model through the Wayselect CLI,
I want `wayselect select` to filter catalog entries by my typed capability requirements and show
why the winner won,
so I can trust the pick without reading every catalog entry by hand.

## 3. Non-goals / guardrails (not negotiable)

- Dry-run only: no live routing, no network calls, no executable URLs. `--fetch` remains the only
  networked path (owned by [TOG-4791](/TOG/issues/TOG-4791)) and never runs in tests.
- No compatibility, cost, or savings claims in output or docs. Catalog presence is not support.
- Node 20+ ESM, stdlib only, thin CLI `bin/wayselect` (per CTO direction [TOG-4403](/TOG/issues/TOG-4403)).
- Tests use small newly-authored fixtures; no redistributed catalog snapshot in the repo.
- Base: branch from the fixture branch [TOG-4781](/TOG/issues/TOG-4781) pushes; rebase onto `main`
  once [TOG-4406](/TOG/issues/TOG-4406) merges it.

## 4. Requirements

- R1 Typed requirements on `select`: input/output modalities, min context window, max output tokens,
  tool calling, structured output, reasoning flag — via flags or a request JSON.
- R2 Missing or unknown capability data fails closed: the entry is excluded with an explicit reason
  (`unknown-capability:<field>`), never treated as supported.
- R3 Stale-evidence gating stays: a stale catalog refuses the decision with a `stale-catalog` error
  before eligibility runs (fail-closed).
- R4 Support-state gating stays: only `configured` / `conformance-tested` entries can be selected.
- R5 Ranking + deterministic tie-break: all else equal, lower list price wins, then lexicographic
  model id. Identical inputs produce byte-identical outputs across runs.
- R6 Every run emits a per-requirement decision trace (which checks ran, pass/fail, reason) plus the
  final verdict, in both human output and `--json` (compatible with the [TOG-4836](/TOG/issues/TOG-4836) explain).
- R7 No eligible route is a first-class outcome: non-zero exit, machine-readable
  `code: "no-eligible-route"`, human output naming the requirement that excluded each candidate.
- R8 `--help` documents every flag; README snippet updated.

## 5. Acceptance script (copy-paste; all must pass)

- A1 `bin/wayselect select --input-modalities text --output-modalities text --min-context-window 128000 --require-tools --json` → exit 0; `selected` satisfies every requirement; `rankedCandidates` and `excluded[{id, reasons[]}]` present.
- A2 Same with `--min-context-window 10000000` → non-zero exit, `code: "no-eligible-route"`, each candidate's excluding requirement named.
- A3 Fixture entry with a missing capability field → excluded with `unknown-capability:<field>`, never selected (fixture `unknown-capability.json`).
- A4 Stale catalog snapshot → `stale-catalog` error before any eligibility output.
- A5 Tie fixture (two fully-qualifying entries) → winner deterministic; two consecutive runs produce identical output bytes.
- A6 Non-`configured` / non-`conformance-tested` entries are never selected.
- A7 `bin/wayselect select --help` lists every R1 flag; README shows one end-to-end example.

## 6. Slice plan (each ≤4h, merged PR, green CI — COO admits, engineers own)

- S1 Filter + fail-closed (R1, R2): typed-requirements filter, unknown-data exclusion + tests.
- S2 Ranking + tie-break (R5): deterministic ordering + byte-identical-output test.
- S3 Select output contract (R6, R7, R8): human + `--json` trace, exit codes, `--help`, README.
- S4 QA golden-output harness (covers A1–A7 end to end, incl. stale + support-state fixtures).
- Suggested owners: S1 Founding Engineer (wrote eligibility), S2–S3 Web Engineer, S4 QA & Release Engineer.

## 7. Seven-day metric + kill/scale rule

- Metric: engineering slices cut from §6 admitted by COO within 7 days of CEO approval of this spec.
  Target: first slice admitted within one COO supply firing; all four admitted within 7 days.
- Kill rule: zero slices admitted within 7 days → spec returns to CPO; CPO re-validates demand with
  CEO before any further Wayselect product work (kills this spec round, never the project).
- Scale rule: ≥2 slices merged green within 7 days → CPO writes the following spec (catalog
  freshness / ingestion follow-up [TOG-4834](/TOG/issues/TOG-4834)).
- Product-question budget: if engineers need more than 2 product clarifications to cut S1–S4, this
  spec failed its "no further product questions" acceptance and CPO revises it within 48h.

## 8. Resolved decisions (no open product questions)

- D1 Next feature is capability-aware select, not ingestion UI or pricing: it is the smallest step
  that makes the trusted catalog + explain loop usable.
- D2 Tie-break is price-then-id (deterministic, explainable); no scoring model in v1.
- D3 No new networked paths; no new config file format (flags or request JSON only).
