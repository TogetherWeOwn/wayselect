# Wayselect buyer spec — listing fields + purchase acceptance (v2)

Status: CPO-owned requirements · v2 supersedes v1 (2026-09-26) · 2026-09-27
Goal: [The TWO Community](/TOG/goals/61e06c97-e4f9-4c56-be57-6af9a2d70376) — smallest sellable buyer slice after catalog schema + dry-run explain.
Supports: [TOG-4830](/TOG/issues/TOG-4830) (catalog-entry JSON schema v1, fail-closed, merged) ·
[TOG-4836](/TOG/issues/TOG-4836) (dry-run eligibility explain, shipped as `select`/`explain` subcommands).
Related: [TOG-4873](/TOG/issues/TOG-4873) (staging E2E) · [TOG-4858](/TOG/issues/TOG-4858) (eligibility matrix) ·
[TOG-5123](/TOG/issues/TOG-5123) (confirm+receipt build spec).

## 0. No-overlap statement

This spec re-specs nothing shipped; it adds the schema-key mapping no script checks today:

| Existing contract | Owner | This spec |
|---|---|---|
| Listing-detail fields, empty/error states, flag matrix | TOG-4882 / [TOG-5010](/TOG/issues/TOG-5010) | Cited, not repeated (§2 maps the buyer-readable subset to exact v1 keys only) |
| Granted/Blocked/Unknown badge derivation | TOG-5221 | Cited; eligibility note (§2) uses its vocabulary |
| Search baseline, compare checks, shortlist forward contract | [TOG-5413](/TOG/issues/TOG-5413) | Cited; §3 click-path points at its M1–M2 surfaces |
| CLI fail-closed eligibility E0–E9, reason-code vocabulary | [TOG-5220](/TOG/issues/TOG-5220) | Cited as vocabulary source (§2–§3 use `missing-capability:` / `unsupported-capability:` / `stale-catalog`) |
| Checkout happy/decline probe (intent → stub refusal) | [TOG-5462](/TOG/issues/TOG-5462) | Cited; §3 steps 3–4 and B6 execute its terminal behavior, not a copy |
| Seller offer/accept | [TOG-5142](/TOG/issues/TOG-5142) | Untouched |
| Staging E2E, endpoint-undeclared precedent | [TOG-4873](/TOG/issues/TOG-4873) | Followed (§4 runs local-tree; no staging endpoint is declared) |

v1 corrections (CEO approval `c36766e1` stands; these reconcile with since-merged work, no scope change):
dry-run is implicit (`select`/`explain`, `dryRun:true`) — no `--dry-run` flag (E8 pins its rejection);
vocabulary is `missing-capability:` / `unsupported-capability:`, never `unknown-capability:`;
Q3/Q4 resolved by shipped code (moved to §7).

## 1. Context

The catalog is trusted ([TOG-4830](/TOG/issues/TOG-4830), merged) and eligibility decisions are
inspectable (`explain`, shipped). The buyer activation slice ([TOG-5413](/TOG/issues/TOG-5413)) and
checkout probe ([TOG-5462](/TOG/issues/TOG-5462)) cover the web surfaces. What no spec pins is the
**schema-key mapping**: which exact `schema/catalog-entry/v1.json` keys back each buyer-visible
listing field. This spec pins that mapping so the purchase slice can be built without further
product questions. Dry-run only: no charge, no payment credentials, no live routing.

Schema basis: `schema/catalog-entry/v1.json` on `main`. All key references below are exact v1
keys, verified against the merged schema. Anything the buyer surface needs that v1 lacks is a
named gap in §5, not silently assumed.

## 2. Buyer-visible listing fields → schema keys

| Buyer field | Schema key(s) | Required in v1? | Display rule |
|---|---|---|---|
| Title | `entry.name` (`entry.id` alongside as stable ref) | Yes | Verbatim; never truncate the id |
| Seller | `providerId` (top-level) | Yes | Seller = provider. `entry.family` is the model family, not the seller — never display it as seller |
| Price | `entry.cost.input`, `entry.cost.output` | No (optional) | As-published synthetic/list-price estimates, no conversion, no totals invented; missing cost → "Price unpublished" (D4) |
| Availability | — (no key; GAP G1) | — | Convention until v1.1: absent `entry.status` or `beta` → listable; `deprecated` → "Unavailable — deprecated" |
| Eligibility note | Derived at render time, never stored: normalized `toolUse`, `modalities`, `limit`/`limits` via the `explain` trace | Inputs required | "Eligible" or the excluding reason named verbatim; unknown data → `missing-capability:<name>`, never eligible |

Also present: `entry.description` (optional subtitle source, not a listing field). Freshness signal
(not a field): `provenance.source` + `provenance.fetchedAt` recorded on every run and carried on
the stub receipt (B7).

## 3. Purchase click-path (each step states expected behavior)

1. **Listing.** Buyer sees the five §2 fields per entry. Entries failing v1 validation are
   rejected before render with provenance in the error (fail-closed, per [TOG-4830](/TOG/issues/TOG-4830)).
   Stale snapshots yield `no-eligible-route` with `stale-catalog` on every candidate before any
   selection (24h catalog-age default, §7 R-Q3).
2. **Eligibility check.** Buyer picks an entry → `explain` trace: per-candidate eligible/excluded
   + reason bullets, human and `--json` (`status`, `selectedRouteId`, `rankedCandidates[].reasons`).
   Ineligible entries name the excluding reason verbatim. Missing/unknown data excludes with
   `missing-capability:<name>`; known-unsupported excludes with `unsupported-capability:<name>`.
3. **Confirm.** Confirm restates title (`entry.name` + `entry.id`), seller (`providerId`), price
   as-quoted, and the eligibility verdict. `validatePurchaseSubmission` accepts `confirm:true`
   into a frozen intent (`src/purchase.js`); `confirm:false` rejects with `unconfirmed`. No charge
   in any path (§7 R-Q4).
4. **Receipt.** Stub receipt carries route, price as-quoted, timestamp, and
   `provenance.source`/`fetchedAt` plus the dry-run disclaimer. `POST …/purchase` never writes:
   unknown listings → `404 listing_not_found` ([TOG-5710](/TOG/issues/TOG-5710)); known listings →
   `403 preview_only`. No charge, no payment fields on the intent shape.
   Full receipt surfaces: [TOG-5123](/TOG/issues/TOG-5123).

## 4. Acceptance script

`bin/accept-wayselect-buyer-listing` (stdlib only). QA runs it from a clean checkout, no setup:

```sh
npm run accept:buyer-listing   # typically < 30s (budget 15m)
```

B1 Schema-key gate: `test/fixtures/valid.json` carries every §2 required key; `malformed.json`
lacks ≥1; `stale.json` is non-v1. (Full ajv validation stays in `npm test`.)
B2 Listing render: all five buyer fields print per entry from exact v1 keys
(G1 convention; missing `entry.cost` → "Price unpublished").
B3 Explain trace: `explain` human + `--json` carry eligible/excluded, `status`, `selectedRouteId`,
per-candidate `reasons`.
B4 Unknown-data exclusion: `unknown-tools` → `missing-capability:toolUse`; `image-lite` →
`unsupported-capability:toolUse`; neither is selected.
B5 Stale fail-closed: evaluation past snapshot+24h → every candidate `stale-catalog`,
`no-eligible-route`, `select` exits 3.
B6 Confirm intent + terminal refusal: `confirm:true` validates to a frozen intent with no payment
fields; `confirm:false` → `unconfirmed`; `POST …/purchase` → `403 preview_only`.
B7 Provenance receipt: explain `provenance` carries source + snapshot; intent preserves it.

Exit 0 with zero failures. No staging endpoint is declared anywhere in repo history, so this run
executes against the local tree and records the endpoint as undeclared ([TOG-4873](/TOG/issues/TOG-4873)
precedent); the same command runs unchanged once an endpoint lands.

## 5. Named gaps (schema lacks these; not assumed)

- **G1 — availability key.** v1 has no availability/listable field. `entry.status` is optional
  with enum `["deprecated","beta"]` only, and absence carries no defined meaning. §2 states the
  interim convention; a v1.1 `availability` enum (or extended `status`) is needed.
- **G2 — support-state vocabulary.** Only `configured` / `conformance-tested` candidates are
  selectable (support states live in `src/support.js`, applied over fixtures), but v1
  `entry.status` offers only `deprecated` / `beta`. Until resolved: listable = status absent or `beta`.
- **G3 — optional price.** `entry.cost` is optional, so price-unpublished listings are legal.
  Whether v1.1 makes cost required is a scope call (Q5).

## 6. Open questions (each with a named decider — no orphans)

- Q1 G1 availability key shape for v1.1 → decider: CTO & Chief AI Officer.
- Q2 G2 support-state vocabulary (`configured`/`conformance-tested` vs current enum) →
  decider: CTO & Chief AI Officer.
- Q5 Whether v1.1 makes `entry.cost` required → decider: CEO (scope), CTO implements.
- Q6 Staging catalog endpoint + snapshot for the first staging run (currently undeclared) →
  decider: QA & Release Engineer.

## 7. Resolved decisions (CPO-owned requirements — no approval needed)

- D1 This slice is buyer listing + specified purchase path, not a payment build.
- D2 Seller = `providerId`; `entry.family` is never the seller.
- D3 Price displayed as-published synthetic/list-price estimates; no conversion, no totals, no compatibility/cost/savings claims.
- D4 Missing `entry.cost` → "Price unpublished"; never invent a number.
- D5 Eligibility note is derived from the `explain` trace at render time, never stored.
- D6 Dry-run only: no charge, no payment credentials, no live routing.
- R-Q3 Stale-catalog threshold is 24h on catalog age (shipped default `DEFAULT_MAX_CATALOG_AGE_HOURS`,
  pinned by E6: snapshot+24h+1s → `stale-catalog`).
- R-Q4 Real vs simulated purchase resolved: every purchase path ends at the stub —
  `403 preview_only`, no backend writes (shipped, [TOG-5413](/TOG/issues/TOG-5413) B8 / [TOG-5462](/TOG/issues/TOG-5462) H5/D4).

## 8. Seven-day metric + kill/scale rule

- Metric: `npm run accept:buyer-listing` executed ≥1 time with zero failures within 7 days of
  merge, by QA without author help; `SUMMARY:` line posted as a comment on
  [TOG-4869](/TOG/issues/TOG-4869).
- Kill rule: zero completed runs within 7 days → spec returns to CPO; CPO re-validates with
  COO (capacity) before any further buyer-surface product work.
- Scale rule: first run green → `accept:buyer-listing` becomes a required gate for every
  subsequent buyer/marketplace slice (mirrors [TOG-5413](/TOG/issues/TOG-5413)).
