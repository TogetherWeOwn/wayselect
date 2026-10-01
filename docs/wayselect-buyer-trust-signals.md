# Wayselect buyer trust-signals spec: ratings, guarantee, dispute entry (TOG-5872)

Product spec for buyer trust signals on the Wayselect preview slice behind
`WAYSELECT_PREVIEW`. Owner: CPO. Budget ≤4h. **No product code on this card** —
spec + acceptance criteria only (same split as
[TOG-5229](/TOG/issues/TOG-5229) spec vs implementation). The next Wayselect
feature slice implements §4–§6 and the `bin/accept-wayselect-trust` script
contract in §7.

Goal link: first payment needs buyer confidence; the smallest sellable trust
slice is display-only ratings + honest guarantee copy + a visible dispute door.
No real charges, reviews, refunds, or moderation exist anywhere in this slice.

## 0. No-overlap statement

| Existing contract | Owner | This spec |
| --- | --- | --- |
| Listing-detail fields F1–F9, empty/error states, flag matrix | TOG-4882 / [TOG-5010](/TOG/issues/TOG-5010) | Cited, not repeated; §3 adds three sections only |
| Granted/Blocked/Unknown badges, index↔detail consistency | TOG-5221 / [TOG-5413](/TOG/issues/TOG-5413) | Cited; rating line never overrides badge state |
| Search/filter S1–S12 | [TOG-5010](/TOG/issues/TOG-5010) | Untouched; rating line survives filtering unchanged |
| Seller offer/accept O0–O9, A1–A8 | [TOG-5142](/TOG/issues/TOG-5142) | Untouched; §6 mirrors its JSON-only stub shape |
| Buyer shortlist SH0–SH10 | [TOG-5413](/TOG/issues/TOG-5413) | Untouched; §6 mirrors its shape, shares no routes |
| Seller payout-status visibility | [TOG-5370](/TOG/issues/TOG-5370) | Untouched: **no payout field, no payout transition, no seller surface** |
| Onboarding copy deck + P1/P3 pins | [TOG-5229](/TOG/issues/TOG-5229) | Pinned decisions reused (§2); no word changed there |

## 1. UI surfaces (named)

All flag-gated behind `WAYSELECT_PREVIEW` (same truthy set as the web spec).
Purchase behavior unchanged: disabled CTA + `403 preview_only` in both flag
states.

| # | Surface | Location | Content |
| --- | --- | --- | --- |
| T1 | Rating summary line | `GET /listings` index, inside each listing `<li>` after the eligibility badge | `★ {avg} · {n} sales` or `No ratings yet` (§2) |
| T2 | Seller-rating section | `GET /listings/:p/:m` detail, after the Eligibility section | `aria-label="Seller rating"`: aggregate line + stub disclaimer (§2) |
| T3 | Guarantee section | Detail, after T2 | `aria-label="Purchase guarantee"`: pinned preview-honest copy (§2) |
| T4 | Dispute entry point | Detail, after T3 | `aria-label="Report a problem"`: entry copy + stub button posting to the §6 route |
| T5 | Fragment parity | `application/json` detail fragment | T2–T4 render from the same builder as the `<noscript>` branch — shell, noscript, and async content never drift |

Ordering on detail is fixed: Eligibility → Seller rating → Purchase guarantee
→ Report a problem → Capabilities. Rating line T1 never moves before the
eligibility badge and never re-ranks index order (stub order preserved).

## 2. Copy deck (v1, pinned)

No word below changes without a Code Reviewer pass on this doc. `{avg}` is one
decimal, `{n}` an integer ≥ 0. Every dynamic value is HTML-escaped (XSS rule
from the web spec binds T1–T4 and the §6 JSON boundary).

| Key | Exact copy |
| --- | --- |
| T1 rated | `★ {avg} · {n} sales` (e.g. `★ 4.6 · 128 sales`) |
| T1 unrated | `No ratings yet` |
| T2 heading | `Seller rating` |
| T2 rated body | `★ {avg} from {n} stub sales.` + ` Stub ratings: synthetic sales history for preview only. Not real buyers.` |
| T2 unrated body | `No ratings yet. This listing has no stub sales history — nothing is hidden, there is just nothing to show.` |
| T3 heading | `Purchase guarantee` |
| T3 body | `Preview build: purchases are disabled, so you can never be charged here. When buying opens, every purchase is covered — if a listing is materially not as described, report it and get a full refund.` |
| T4 heading | `Report a problem` |
| T4 body | `Something wrong with this listing? File a stub report — nothing leaves this preview, and filing never charges or refunds anything.` |
| T4 button | `Report a problem (stub)` |

Fail-closed rules: missing/non-numeric rating data renders the unrated copy —
never a default score, never stars without a count. Guarantee copy never
promises a live charge, a real refund path, or a timeline; the launch wording
(`full refund`) is intent, effective only when buying opens.

## 3. Rating data contract (stub, display-only)

Stub listings gain an optional `rating` object: `{average: number, sales:
integer}`. Pinned stub values for acceptance:

| Listing | Rating |
| --- | --- |
| `northstar/alpha-chat` | `{average: 4.6, sales: 128}` |
| `northstar/image-lite` | `{average: 3.9, sales: 17}` |
| `northstar/unknown-tools` | absent → unrated copy (§2 T2 unrated) |

Validation (next slice enforces, script probes): `average` finite, 0–5
inclusive; `sales` integer ≥ 0; any violation → unrated copy (fail closed, page
still 200). No reviewer names, no review text, no write path in v1 — aggregate
display only (smallest sellable; text reviews are a later slice).

## 4. Baseline regression (runnable today, must stay green)

Against the shipped slice, before the trust slice lands:

| # | Request | Expected |
| --- | --- | --- |
| B1 | `GET /listings` (flag on) | 200, stub order, eligibility badges intact (buyer-spec B1–B4) |
| B2 | Detail pages (flag on) | F1–F9 fields, eligibility section, disabled CTA (web-spec §1) |
| B3 | `POST …/purchase` (either flag state) | 403 JSON `{error:"preview_only"}` — trust copy never arms a charge |
| B4 | Detail pages | No `Seller rating`, `Purchase guarantee`, or `Report a problem` sections yet (slice-absent marker; becomes FAIL once §5 lands incompletely) |

## 5. Forward contract (next slice; script auto-skips until present)

| # | Request | Expected |
| --- | --- | --- |
| R1 | `GET /listings` (flag on) | Each `<li>` carries its T1 line: `alpha-chat` → `★ 4.6 · 128 sales`; `image-lite` → `★ 3.9 · 17 sales`; `unknown-tools` → `No ratings yet` |
| R2 | Detail T2 per listing | `aria-label="Seller rating"` section; rated body verbatim per §2 (numbers match §3); `unknown-tools` → unrated body verbatim |
| R3 | Rating + eligibility consistency | T1 line matches T2 numbers on the same listing; eligibility badge state unchanged beside the rating line |
| R4 | Filtered index (search slice present) | T1 lines survive filtering unchanged (filtering never drops or recomputes ratings) |
| G1 | Detail T3, every listing | `aria-label="Purchase guarantee"` section with T3 body verbatim |
| G2 | T3 + CTA consistency | Guarantee section present AND purchase CTA still disabled with 403 `preview_only` — copy never contradicts the stub |
| D1 | Detail T4, every listing | `aria-label="Report a problem"` section with T4 body + stub button targeting the §6 route |
| D2 | `GET /listings/northstar/alpha-chat/disputes` (flag on, fresh) | 200 JSON `{listing:"northstar/alpha-chat", disputes:[]}` |
| D3 | `POST …/disputes` `{"buyer":"mia","reason":"not_as_described"}` | 201 JSON `{id:"dispute-1", listing:"northstar/alpha-chat", buyer:"mia", reason:"not_as_described", status:"open"}` |
| D4 | `GET …/disputes` after D3 | 200, contains `dispute-1` with `status:"open"` |
| D5 | `POST …/disputes` missing/blank/overlong buyer (>120), unknown reason, unknown fields | 400 JSON `{error:"invalid_dispute", …}` naming valid reasons (fail closed) |
| D6 | `POST /listings/northstar/nope/disputes` valid body | 404 JSON `{error:"not_found"}` (only real stub listings take reports) |
| D7 | Malformed JSON / wrong Content-Type | 400 `invalid_dispute` |
| D8 | Evil buyer `<script>alert(1)</script>` | 201 accepted as data; JSON safely encoded; any future HTML view must escape it |
| D9 | Any `/disputes` route, flag off | 404 preview-disabled (HTML or JSON `{error:"preview_disabled"}`, either passes with 404 + flag named) |
| D10 | `POST …/purchase` after D3 | Still 403 `preview_only` — filing a stub report never charges, refunds, or writes beyond memory |

Dispute request shape (v1): `Content-Type: application/json`,
`{buyer: string (trimmed, 1–120 chars), reason: enum
(not_as_described|never_delivered|billing_issue|other)}`. Unknown fields →
`400 invalid_dispute`. IDs deterministic per listing per process
(`dispute-1`, …); restart clears. JSON-only, no auth (stub data, §8 G2).

## 6. No-overlap guard rows

| # | Request | Expected |
| --- | --- | --- |
| N1 | Detail pages | No payout field, payout state, or seller dashboard surface (TOG-5370 owns those) |
| N2 | `npm run accept:web && npm run accept:seller && npm run accept:buyer` | Exit 0 — trust slice regresses nothing |

## 7. Runnable acceptance script contract (next slice implements)

`bin/accept-wayselect-trust` (zero dependencies, stdlib only): starts the real
server on ephemeral ports; checks §4 today; §5 probes report
`SKIP (trust slice not present)` until the slice lands, then must report zero
skips. Expected tail today: `SUMMARY: 4 pass, 0 fail, 19 skip — 0.0s (budget
15m)`. Exit 0 with zero failures (skips allowed), 1 otherwise. QA
end-to-end: `node --version` (20+) → `npm run accept:trust` → regression
trio per N2 → paste `SUMMARY:` lines + `FAIL` lines; any FAIL rejects.

## 8. Sign-off, metric, kill/scale

- [ ] COO: spec accepted (confirmation card on this issue) or revised with reason.
- [ ] Engineer (next slice): script executes end-to-end in under 15 minutes.
- [ ] QA: pass/fail/skip semantics independently reproducible from a clean checkout.
- [ ] Code Reviewer: one pass on the doc (docs-only; no Security/CISO/QA review — no auth, secrets, payments, or public exposure).

Seven-day metric (by 2026-10-04): this spec accepted or revised with reason —
1 accepted spec. Kill rule: if no trust slice lands to execute §5 against
within 14 days of acceptance, archive §5 instead of maintaining it. Scale
rule: once executed green with zero skips, `npm run accept:trust` becomes a
required gate for every subsequent buyer/marketplace slice. Review date:
2026-10-04.

## 9. Accepted gaps

- G1: aggregate ratings only; no review text, reviewer identity, or
  helpfulness votes. Accepted: smallest sellable; text reviews are a later
  slice with their own moderation contract.
- G2: disputes are in-memory, `open`-only; no triage, resolution, or refund
  path. Accepted: preview stub; resolution flow is a later slice.
- G3: no buyer/seller auth; anyone with the flag can file stub reports.
  Accepted: stub data only, no real money, no backend writes.
- G4: guarantee `full refund` line is launch intent, unenforceable in
  preview. Accepted: T3 body states purchases are disabled first.
