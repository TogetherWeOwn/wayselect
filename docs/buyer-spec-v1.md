# Wayselect buyer spec — listing fields + purchase acceptance script (v1)

Status: proposed for CEO approval · CPO-owned requirements · 2026-09-26
Goal: [The TWO Community](/TOG/goals/61e06c97-e4f9-4c56-be57-6af9a2d70376) — smallest sellable buyer slice after catalog schema + dry-run explain.
Supports: [TOG-4830](/TOG/issues/TOG-4830) (catalog-entry JSON schema v1, fail-closed) ·
[TOG-4836](/TOG/issues/TOG-4836) (CLI `--dry-run` eligibility explain).
Related QA leaves: [TOG-4873](/TOG/issues/TOG-4873) (staging E2E) · [TOG-4858](/TOG/issues/TOG-4858) (eligibility matrix).

## 1. Context

The catalog can soon be trusted ([TOG-4830](/TOG/issues/TOG-4830)) and eligibility decisions
inspected ([TOG-4836](/TOG/issues/TOG-4836)). The next sellable step is the buyer surface: what a
buyer sees on a listing, and the exact click-path from listing to receipt — specified now so the
purchase slice can be built without further product questions. This spec is dry-run only: no
charge, no payment credentials, no live routing (guardrails inherited from the v1 select spec).

Schema basis: `schema/catalog-entry/v1.json` from PR #2 ([TOG-4830](/TOG/issues/TOG-4830)).
All key references below are exact v1 keys. Anything the buyer surface needs that v1 lacks is
filed as a named gap in §5, not silently assumed.

## 2. Buyer-visible listing fields → schema keys

| Buyer field | Schema key(s) | Required in v1? | Display rule |
|---|---|---|---|
| Title | `entry.name` (`entry.id` alongside as stable ref) | Yes | Verbatim; never truncate the id |
| Seller | `providerId` (top-level) | Yes | Seller = provider. `entry.family` is the model family, not the seller — never display it as seller |
| Price | `entry.cost.input`, `entry.cost.output` | No (optional) | As-published rates, no conversion, no totals invented; missing cost → "Price unpublished" (D4) |
| Availability | — (no key; GAP G1) | — | Convention until v1.1: absent `entry.status` or `beta` → listable; `deprecated` → "Unavailable — deprecated" |
| Eligibility note | Derived, not stored: `entry.modalities`, `entry.limit`, `entry.tool_call`, `entry.reasoning`, `entry.structured_output` via the [TOG-4836](/TOG/issues/TOG-4836) explain trace | Inputs required | "Eligible" or the excluding requirement named; unknown capability data → `unknown-capability:<field>`, never eligible |

Freshness signal (not a listing field): `provenance.source` + `provenance.fetchedAt` must be
recorded on every acceptance run and shown on the receipt (§4 step 4).

## 3. Purchase click-path (each step states expected staging behavior)

1. **Listing.** Buyer sees the five §2 fields per entry. Entries failing v1 validation are
   rejected before render with provenance in the error (fail-closed, per [TOG-4830](/TOG/issues/TOG-4830)).
   Stale snapshots refuse the run with `stale-catalog` before any eligibility output
   (threshold: Q3).
2. **Eligibility check.** Buyer picks an entry → CLI runs the `--dry-run` explain
   ([TOG-4836](/TOG/issues/TOG-4836)): per-requirement pass/fail + final verdict, human and
   `--json`. Ineligible entries name the excluding requirement. Missing/unknown capability data
   excludes with `unknown-capability:<field>`.
3. **Confirm.** Confirm screen restates title (`entry.name` + `entry.id`), seller
   (`providerId`), price as-quoted, and the eligibility verdict. No charge is made in this
   slice; confirm records intent only. Real vs simulated purchase on staging: Q4.
4. **Receipt.** Receipt shows what was selected, price as-quoted, timestamp,
   `provenance.source` + `provenance.fetchedAt`, and a dry-run disclaimer. No payment
   credentials are collected anywhere in this slice.

## 4. Acceptance script

`scripts/buyer-acceptance.sh` (in this repo). QA runs it with one env var:

```sh
STAGING_CATALOG=<url-or-path-to-catalog-snapshot> scripts/buyer-acceptance.sh
```

It executes all seven checks end to end with no author help and prints a verdict per step:

- B1 Catalog fetch: snapshot reachable; `provenance.source`/`fetchedAt` recorded.
- B2 Schema validation: every entry carries the §2 required keys; malformed entries rejected
  with provenance in the error.
- B3 Listing render: all five buyer fields render per entry from exact v1 keys
  (availability per the G1 convention; missing `entry.cost` → "Price unpublished").
- B4 Eligibility trace: `--dry-run` explain present per [TOG-4836](/TOG/issues/TOG-4836)
  (BLOCKED verdict while [TOG-4836](/TOG/issues/TOG-4836) is unmerged — run continues).
- B5 Unknown-capability exclusion: fixture entry with a missing capability field is excluded
  with `unknown-capability:<field>`, never selected.
- B6 Stale-catalog fail-closed: stale snapshot → `stale-catalog` before eligibility output.
- B7 Confirm + receipt surfaces: specified-not-built until the purchase slice; step records a
  named defect and continues (expected FAIL, not a silent skip).

Verdicts are `PASS` / `FAIL` (+ named defect) / `BLOCKED` (owning issue named). A completed run
— all steps executed with verdicts — counts for the seven-day metric even with expected FAILs.

## 5. Named gaps (schema lacks these; not assumed)

- **G1 — availability key.** v1 has no availability/listable field. `entry.status` is optional
  with enum `["deprecated","beta"]` only, and absence carries no defined meaning. §2 states the
  interim convention; a v1.1 `availability` enum (or extended `status`) is needed.
- **G2 — support-state vocabulary.** The v1 select spec requires only `configured` /
  `conformance-tested` entries to be selectable, but v1 `entry.status` offers only
  `deprecated` / `beta`. Until resolved: listable = status absent or `beta`.
- **G3 — optional price.** `entry.cost` is optional, so price-unpublished listings are legal.
  Whether v1.1 makes cost required is a scope call (Q5).

## 6. Open questions (each with a named decider — no orphans)

- Q1 G1 availability key shape for v1.1 → decider: CTO & Chief AI Officer.
- Q2 G2 support-state vocabulary (`configured`/`conformance-tested` vs current enum) →
  decider: CTO & Chief AI Officer.
- Q3 Stale-catalog threshold (proposed default: 24h on `provenance.fetchedAt`) →
  decider: Founding Engineer (owns eligibility semantics).
- Q4 Real vs simulated purchase on staging; payment-path scope (contractual/financial —
  owner-reserved) → decider: CEO.
- Q5 Whether v1.1 makes `entry.cost` required → decider: CEO (scope), CTO implements.
- Q6 Staging catalog endpoint + snapshot for the first acceptance run →
  decider: QA & Release Engineer (records endpoint + CLI SHA per [TOG-4873](/TOG/issues/TOG-4873)).

## 7. Resolved decisions (CPO-owned requirements — no approval needed)

- D1 This slice is buyer listing + specified purchase path, not a payment build.
- D2 Seller = `providerId`; `entry.family` is never the seller.
- D3 Price displayed as-published; no conversion, no totals, no compatibility/cost/savings claims.
- D4 Missing `entry.cost` → "Price unpublished"; never invent a number.
- D5 Eligibility note is derived from the dry-run trace at render time, never stored.
- D6 Dry-run only: no charge, no payment credentials, no live routing.

## 8. Seven-day metric + kill/scale rule

- Metric: `scripts/buyer-acceptance.sh` executed ≥1 time against staging within 7 days of
  merge, by QA & Release Engineer without author help; run record posted as a comment on
  [TOG-4869](/TOG/issues/TOG-4869).
- Kill rule: zero completed runs within 7 days → spec returns to CPO; CPO re-validates with
  COO (capacity) before any further buyer-surface product work.
- Scale rule: first run green on B1–B6 → CPO writes the purchase-slice build spec
  (confirm/receipt implementation closing B7).
