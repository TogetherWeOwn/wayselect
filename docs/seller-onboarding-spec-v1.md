# Wayselect seller-onboarding spec — seller flow + listing creation + acceptance script (v1)

Status: proposed for CEO approval · CPO-owned requirements · 2026-09-26
Goal: [Agent-Run Revenue, Zero Owner Hours](/TOG/goals/f9e0ab30-bf0c-4b1f-af7e-943210ec80c7) — smallest sellable seller slice after catalog schema + buyer spec + dry-run explain.
Supports: [TOG-4830](/TOG/issues/TOG-4830) (catalog-entry JSON schema v1, fail-closed) ·
[TOG-4836](/TOG/issues/TOG-4836) (CLI `--dry-run` eligibility explain) ·
[TOG-4869](/TOG/issues/TOG-4869) (buyer listing fields + purchase path).
Build follow-up: [TOG-4969](/TOG/issues/TOG-4969) (Web seller build slice, blocked by this spec).
Related QA leaves: [TOG-4873](/TOG/issues/TOG-4873) (staging E2E) · [TOG-4858](/TOG/issues/TOG-4858) (eligibility matrix).

## 1. Context

The catalog can soon be trusted ([TOG-4830](/TOG/issues/TOG-4830)), eligibility decisions
inspected ([TOG-4836](/TOG/issues/TOG-4836)), and the buyer surface is specified
([TOG-4869](/TOG/issues/TOG-4869)). The next sellable step is the seller side: how a seller
submits a listing, sees it validated fail-closed, previews eligibility, and confirms
listing creation — specified now so the seller build slice can be built without further
product questions. This spec is dry-run only: no live publish, no seller credentials, no
live routing, no payment or payout (guardrails inherited from the buyer spec).

Schema basis: `schema/catalog-entry/v1.json` from PR #2 ([TOG-4830](/TOG/issues/TOG-4830)).
All key references below are exact v1 keys. Anything the seller flow needs that v1 lacks is
filed as a named gap in §5, not silently assumed.

## 2. Seller-submitted listing fields → schema keys

| Seller field | Schema key(s) | Required in v1? | Submission rule |
|---|---|---|---|
| Seller identity | `providerId` (top-level) | Yes | Non-empty string; seller = provider. `entry.family` is the model family, not the seller — never accept it as seller identity |
| Listing ID | `modelId` (top-level) + `entry.id` | Yes | Interim: submit them equal (GAP SG2); mismatch → reject as a named defect |
| Title | `entry.name` | Yes | Verbatim; never truncate the id |
| Description | `entry.description` | Yes | Plain text; no compatibility, cost, or savings claims |
| Capability flags | `entry.attachment`, `entry.reasoning`, `entry.tool_call` (+ optional `entry.structured_output`, `entry.temperature`) | First three Yes; rest optional | Booleans. Absent optional flags → unknown capability data, never eligible (`missing-capability:<field>`) |
| Modalities | `entry.modalities.input`, `entry.modalities.output` | Yes | Non-empty arrays; enum `text`, `image`, `audio`, `video`, `pdf` |
| Limits | `entry.limit.context`, `entry.limit.output` (+ optional `entry.limit.input`) | context + output Yes | Integers ≥ 0 |
| Price | `entry.cost.input`, `entry.cost.output` | No (optional) | As-published rates, no conversion, no totals invented; missing cost → "Price unpublished" (SD4) |
| Release info | `entry.release_date`, `entry.last_updated` | Yes | `YYYY-MM` or `YYYY-MM-DD` |
| Open weights | `entry.open_weights` | Yes | Boolean |
| Listing status | `entry.status` | No (enum `deprecated`/`beta` only) | Convention until v1.1 (same as buyer G1): absent or `beta` → listable; `deprecated` → "Unavailable — deprecated" |
| Provenance | `provenance.source` + `provenance.fetchedAt` (+ optional `etag`) | Yes | Every submission carries its source; every rejection names it |
| Support & evidence | — (no v1 key; GAP SG3) | — | Submitted alongside per the configuration shape (`supportState`, `operations`, `evidence.observedAt`); new listings enter as `catalogued` only (SD7) |

Freshness signals (not listing fields): `provenance.fetchedAt` is recorded on every
acceptance run; per-candidate `evidence.observedAt` is checked against the evidence-age
limit (default proposed in SQ3).

## 3. Seller flow / listing creation (each step states expected staging behavior)

1. **Submit.** Seller submits `providerId` + entry fields per §2. Entries failing v1
   validation are rejected before any preview, with provenance in the error (fail-closed,
   per [TOG-4830](/TOG/issues/TOG-4830)). Unknown fields are rejected at every object level
   (`additionalProperties: false`). Missing provenance → reject.
2. **Validation preview.** System shows the normalized capabilities (`attachment`,
   `reasoning`, `toolUse`, `structuredOutput`, `imageInput`, `textInput`, `textOutput`),
   derived catalog operations (`chat` from text-in/text-out, `vision-chat` from
   image-in/text-out), and rates as-published. Unknown capability data warns with
   `missing-capability:<field>` and is never eligible.
3. **Support & evidence.** Seller requests `supportState` + `operations` +
   `evidence.observedAt`. `configured` / `conformance-tested` require non-empty
   operations; anything else → reject. Evidence older than the limit → `stale-evidence`
   exclusion; absent → `missing-evidence`. Stale catalog snapshots refuse the run with
   `stale-catalog` before any eligibility output (thresholds: SQ3).
4. **Eligibility preview.** Runs the `--dry-run` explain ([TOG-4836](/TOG/issues/TOG-4836)):
   per-requirement pass/fail + final verdict, human and `--json`. Ineligible listings name
   the excluding requirement with exact reason codes: `support-state:<state>`,
   `provider-not-allowed`, `operation-not-catalogued`, `operation-not-configured`,
   `missing-capability:<cap>`, `unsupported-capability:<cap>`, `missing-evidence`,
   `stale-evidence`, `future-evidence`, `stale-catalog` / `future-catalog`.
5. **Confirm.** Confirm screen restates route (`providerId`/`modelId`), title
   (`entry.name` + `entry.id`), price as-quoted, `supportState` + operations + evidence
   age, and the eligibility verdict. No live publish is made in this slice; confirm
   records intent only. Real vs simulated publish on staging: SQ4 (CEO).
6. **Listing-created receipt.** Receipt shows what was created, price as-quoted,
   timestamp, `provenance.source` + `provenance.fetchedAt`, and a dry-run disclaimer. No
   payment or payout credentials are collected anywhere in this slice. Executable location
   fields (`url`, `endpoint`, `baseUrl`, `apiUrl`) are never accepted on submissions.

## 4. Acceptance script

`scripts/seller-acceptance.sh` (in this repo). QA runs it with one env var
(`STAGING_CONFIG` optional):

```sh
STAGING_CATALOG=<url-or-path-to-catalog-snapshot> scripts/seller-acceptance.sh
```

It executes all seven checks end to end with no author help and prints a verdict per step:

- S1 Catalog fetch: snapshot reachable; `provenance.source` + snapshot timestamp recorded
  (accepts `snapshotTimestamp` on current fixtures or `fetchedAt` on v1 entries).
- S2 Schema validation: every submitted entry carries the §2 required keys; malformed
  entries rejected with provenance in the error; an injected unknown field is refused
  fail-closed (live CLI probe).
- S3 Seller-field render: seller, route, title, price, modalities, and support/evidence
  render from exact keys (missing `entry.cost` → "Price unpublished").
- S4 Eligibility preview trace: `--dry-run` explain present per [TOG-4836](/TOG/issues/TOG-4836)
  (BLOCKED verdict while [TOG-4836](/TOG/issues/TOG-4836) is unmerged — run continues).
- S5 Unknown-capability exclusion: fixture entry missing a capability field is excluded
  with `missing-capability:<field>`, never selected (live CLI probe: `northstar/unknown-tools`
  → `missing-capability:toolUse`).
- S6 Stale-catalog fail-closed: stale snapshot probes `fresh:false` and a fresh snapshot
  probes `fresh:true` (24h limit); the run refuses stale output with `stale-catalog`.
- S7 Confirm + listing-created surfaces: specified-not-built until [TOG-4969](/TOG/issues/TOG-4969);
  step records a named defect and continues (expected FAIL, not a silent skip).

Verdicts are `PASS` / `FAIL` (+ named defect) / `BLOCKED` (owning issue named). A completed run
— all steps executed with verdicts — counts for the seven-day metric even with expected FAILs.

## 5. Named gaps (schema lacks these; not assumed)

- **SG1 — seller identity / auth.** v1 carries `providerId` as a bare string with no proof
  of provider ownership: anyone can submit any `providerId`. Seller auth is unspecified.
- **SG2 — `modelId` vs `entry.id` consistency.** The v1 validator (`src/validate-catalog-entry.js`
  on [TOG-4830](/TOG/issues/TOG-4830)) checks `schemaVersion` + JSON-schema shape only; it does
  not enforce `modelId == entry.id`. §2 states the interim convention (submit equal); a
  mismatch is a rejectable defect, and v1.1 should enforce it.
- **SG3 — support-state vocabulary.** Support configuration (`supportState`, `operations`,
  `evidence.observedAt`) lives outside v1 entirely, and v1 `entry.status` offers only
  `deprecated` / `beta`. Until resolved: new listings enter as `catalogued` only (SD7).
- **SG4 — availability key.** Same as buyer G1: v1 has no availability/listable field.
- **SG5 — optional price.** Same as buyer G3: `entry.cost` is optional, so
  price-unpublished listings are legal; whether v1.1 makes cost required is a scope call (SQ5).
- **SG6 — executable location fields.** Transport rejects `url` / `endpoint` / `baseUrl` /
  `apiUrl` anywhere in a route; submissions must never carry them. (Note: v1 `provider.api`
  is a plain string key inside `entry.provider`, not a transport route field.)

## 6. Open questions (each with a named decider — no orphans)

- SQ1 SG4 availability key shape for v1.1 → decider: CTO & Chief AI Officer.
- SQ2 SG3 support-state vocabulary (`configured`/`conformance-tested` vs current enum) →
  decider: CTO & Chief AI Officer.
- SQ3 Stale-catalog threshold (proposed default: 24h on `provenance.fetchedAt`) and
  stale-evidence threshold (proposed default: 72h on `evidence.observedAt`, per current
  `fixtures/request.synthetic.json`) → decider: Founding Engineer (owns eligibility semantics).
- SQ4 Real vs simulated publish on staging; seller payout/billing scope (contractual/financial —
  owner-reserved) → decider: CEO.
- SQ5 Whether v1.1 makes `entry.cost` required → decider: CEO (scope), CTO implements.
- SQ6 Staging catalog endpoint + snapshot for the first acceptance run →
  decider: QA & Release Engineer (records endpoint + CLI SHA per [TOG-4873](/TOG/issues/TOG-4873)).
- SQ7 Seller identity proof for `providerId` (SG1; auth/security — owner-reserved implications) →
  deciders: CISO + CEO.

## 7. Resolved decisions (CPO-owned requirements — no approval needed)

- SD1 This slice is seller submission + specified listing-creation path, not a publish build.
- SD2 Seller = `providerId`; `entry.family` is never the seller.
- SD3 Price displayed as-published; no conversion, no totals, no compatibility/cost/savings claims.
- SD4 Missing `entry.cost` → "Price unpublished"; never invent a number.
- SD5 Eligibility note is derived from the dry-run trace at preview time, never stored.
- SD6 Dry-run only: no live publish, no seller credentials, no live routing.
- SD7 New listings enter as `catalogued` only; `configured` / `conformance-tested` require
  explicit non-empty operations plus fresh evidence.
- SD8 Unknown fields are rejected fail-closed; every rejection carries provenance.

## 8. Seven-day metric + kill/scale rule

- Metric: `scripts/seller-acceptance.sh` executed ≥1 time against staging within 7 days of
  merge, by QA & Release Engineer without author help; run record posted as a comment on
  [TOG-4958](/TOG/issues/TOG-4958).
- Kill rule: zero completed runs within 7 days → spec returns to CPO; CPO re-validates with
  COO (capacity) before any further seller-surface product work.
- Scale rule: first run green on S1–S6 → Web Engineer builds [TOG-4969](/TOG/issues/TOG-4969)
  (confirm / listing-created implementation closing S7).
