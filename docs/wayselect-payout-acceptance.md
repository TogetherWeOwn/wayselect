# Wayselect seller payout-status acceptance: accepted offer → pending → released (TOG-5370)

Merged product spec and executable acceptance for the next Wayselect seller
slice behind `WAYSELECT_PREVIEW`. Slice status:

| Step | Meaning | Card | Status |
| --- | --- | --- | --- |
| List | Seller verifies their listing is visible in `GET /listings` + detail | TOG-4882 (shipped) | Baseline, covered today |
| Offer | Buyer posts a stub offer on a listing | [TOG-5142](/TOG/issues/TOG-5142) | Forward contract; script auto-skips until it lands |
| Accept | Seller accepts one offer; others supersede | [TOG-5142](/TOG/issues/TOG-5142) | Forward contract; script auto-skips until it lands |
| Payout visibility | Seller (and buyer) see payout state per accepted offer; seller releases it | — (this card) | Forward contract only (§1–§3); script auto-skips until it lands |

Non-goals (inherited): no live provider calls, no credentials, no backend
writes beyond in-memory stub state, no real money, no payout rails, no auth,
no persistence across restarts. All amounts are synthetic list-price estimates
copied verbatim from stub offer prices. The purchase endpoint always refuses
(`403 preview_only`) — a release never performs a purchase or moves money.

## 0. No-overlap statement

[TOG-5123](/TOG/issues/TOG-5123) (part-2 purchase confirm+receipt build spec)
and [TOG-4861](/TOG/issues/TOG-4861) (part-1 capability-aware select) are
cited, not re-spec'd. This card covers only what neither touches:

| Existing contract | Owner | This spec |
| --- | --- | --- |
| Confirm page + receipt POST, R1–R9, C1–C12 | [TOG-5123](/TOG/issues/TOG-5123) | Untouched; R11 pins that release never performs a purchase |
| Capability-aware select R1–R8, A1–A7 | [TOG-4861](/TOG/issues/TOG-4861) | Untouched |
| Seller offer/accept O0–O9, A1–A8 | [TOG-5142](/TOG/issues/TOG-5142) | Cited as the payout source (an accept creates exactly one payout); re-specs nothing |
| Buyer search/compare/shortlist B1–B9, F1–F3, SH0–SH10 | [TOG-5413](/TOG/issues/TOG-5413) | Untouched; that spec reserves payout-status to this card |
| Listing-detail fields F1–F9, error states, flag matrix | [TOG-5010](/TOG/issues/TOG-5010) | Cited; §1 adds the Payout section only |
| Granted/Blocked/Unknown badge derivation | TOG-5221 | Cited; §1 reuses the badge classes for payout state |

## 1. Listing payout fields (forward contract for the next slice)

Once the slice lands, the detail page gains a Payout section. Amounts render
as `$X` with the synthetic-only disclaimer adjacent (F6 convention).

| # | Request | Expected |
| --- | --- | --- |
| P1 | `GET /listings/northstar/alpha-chat` (flag on, fresh server, no accepts) | 200, `<section aria-label="Payout">` with `No payouts yet` copy (payouts appear only after an offer is accepted) |
| P2 | same after offer-1 accepted at price 12 | Section lists `<code>payout-1</code>`, `$12` + synthetic-only disclaimer, buyer `mia`, badge `Pending` (`badge-unknown`) |
| P3 | same after `payout-1` released | Same row, badge `Released` (`badge-granted`); amount and buyer unchanged |
| P4 | accepted offer with evil buyer `<script>alert(1)</script>` | Payout row HTML-escapes the buyer name; the JSON API round-trips it raw |
| P5 | detail page with the flag off | 404 preview-disabled (existing behavior, unchanged) |

Badge mapping: `pending` → `badge-unknown`, `released` → `badge-granted`.
The amount is the accepted offer price verbatim — no fees, no currency math
(explicit non-goal).

## 2. Payout read + release contract (forward contract for the next slice)

Payouts are a derived, read-plus-one-transition resource. Accepting an offer
creates exactly one payout:

```json
{id:"payout-1", offer:"offer-1", listing:"northstar/alpha-chat", buyer:"mia", amount:12, status:"pending"}
```

Open or superseded offers never yield payouts. IDs are deterministic per
listing per process (`payout-1`, `payout-2`, …); restart resets (gap G1).
The only transition is `pending` → `released`, via an empty-body POST.

| # | Request | Expected |
| --- | --- | --- |
| R0 | `GET /listings/northstar/alpha-chat/payouts` (flag on, fresh server) | 200 JSON `{listing:"northstar/alpha-chat", payouts:[]}` — empty initially |
| R1 | same after offer-1 accepted (price 12, buyer mia) | 200, `payouts` contains `payout-1` with `status:"pending"`, `buyer:"mia"`, `amount:12` |
| R2 | `GET …/payouts/payout-1` | 200 single payout, `status:"pending"` |
| R3 | `GET …/offers/offer-1` after accept | 200, includes `payout:{id:"payout-1", status:"pending"}` — buyer- and seller-visible; `payout:null` while the offer is open |
| R4 | `POST …/payouts/payout-1/release` (pending) | 200 JSON `{id:"payout-1", status:"released", …}` |
| R5 | `GET …/payouts/payout-1` and `GET …/offers/offer-1` after R4 | Both read `released` (offer pointer follows the payout) |
| R6 | `POST …/payouts/payout-1/release` again (double-release) | 409 JSON `{error:"payout_conflict", …}` |
| R7 | `POST …/payouts/payout-999/release` (unknown payout) | 404 JSON `{error:"not_found"}` |
| R8 | `GET`/`POST` payouts or release on `northstar/nope` | 404 JSON `{error:"not_found"}` |
| R9 | `GET …/payouts/payout-1/release` | 405 JSON `{error:"method_not_allowed"}` |
| R10 | `POST …/release` with malformed JSON, wrong `Content-Type`, or a non-empty body | 400 JSON `{error:"invalid_payout", …}` naming the empty-body rule (fail closed, never default) |
| R11 | `POST …/purchase` after release | Still 403 `preview_only` — releasing a stub payout never performs a purchase or moves money |
| R12 | payout id derived from an open offer (e.g. `payout-2` before any second accept) | 404 `not_found` — only accepted offers yield payouts |

Release request body: empty (no fields required in v1). Any field present →
`400 invalid_payout`.

## 3. Flag-gating matrix (mirrors the seller §4 shape)

`WAYSELECT_PREVIEW` truthy values (trimmed, case-insensitive): `1`,
`true`, `yes`, `on`. Anything else, including unset, is off.

| Route | Flag on | Flag off |
| --- | --- | --- |
| `GET …/payouts`, `GET …/payouts/:id` | 200 JSON, or 404 not-found | 404 preview-disabled (HTML page or JSON `{error:"preview_disabled"}` — either passes if status is 404 and body names the flag) |
| `POST …/payouts/:id/release` | 200, or 4xx per §2 | 404 preview-disabled (`{error:"preview_disabled"}` or HTML naming the flag) |
| `POST …/purchase` | 403 `preview_only` | 403 `preview_only` (ungated by design) |

## 4. Runnable acceptance script (under 15 minutes)

```sh
node --version            # 20+
npm run accept:payout     # this acceptance script, typically < 5s
npm run accept:seller     # regression: seller baseline still green
npm run accept:web        # regression: listing slice still green
```

`bin/accept-wayselect-payout` (zero dependencies, stdlib only) starts the
real server on ephemeral ports and checks the §1 baseline rows that run
today. Sections §1-forward (P1–P5) and §2–§3 payout probes run only when the
payout slice is present; until then they report
`SKIP (payout slice not present)` and the run still exits 0. Expected tail
output today:

```
SUMMARY: 3 pass, 0 fail, 21 skip — 0.0s (budget 15m)
```

Exit code is 0 with zero failures (skips allowed), 1 otherwise. The next
slice is accepted when the same command reports zero skips and zero fails.

QA end-to-end (reviewer-checkable, no setup beyond a clean checkout):

1. `node --version` → 20+ (else FAIL).
2. `npm run accept:payout` → exit 0, note pass/fail/skip counts.
3. `npm run accept:seller && npm run accept:web` → exit 0 (no regression).
4. Report: paste the three `SUMMARY:` lines plus any `FAIL` lines as the
   pass/fail record. Skips are expected until the payout slice lands;
   any FAIL is a rejection.

## 5. Sign-off, metric, kill/scale

- [ ] Engineer: script executes end-to-end in under 15 minutes against the next payout slice.
- [ ] QA: pass/fail/skip semantics independently reproducible (`npm run accept:payout` from a clean checkout).
- [ ] Code Reviewer: one pass on the script + doc (docs + test-script-only change; no Security/CISO/QA review — no auth, secrets, real payments, or public exposure in the diff; amounts are synthetic stub data).

Seven-day metric (by 2026-10-04): script executed (0 fail) against the
current tree (baseline green, payout skips allowed) and cited by the next
Wayselect build slice — 1 accepted script. Kill rule: if no payout slice
lands to execute §1–§3 against within 14 days, archive §1–§3 instead of
maintaining them. Scale rule: once executed green with zero skips,
`npm run accept:payout` becomes a required gate for every subsequent
seller/marketplace slice. Review date: 2026-10-04.

Goal link: company north star "Agent-Run Revenue, Zero Owner Hours" via
validated-bet discipline — this card ships requirements + acceptance before
build, per the CPO revenue contribution rule (no engineering card without a
stated user outcome and acceptance criteria).

## 6. Accepted gaps

- G1: payouts are in-memory only; a server restart clears them. Accepted:
  the script uses a fresh ephemeral server per run, so IDs are
  deterministic (`payout-1`, …) within the run.
- G2: no seller auth in v1; anyone with the preview flag can read/release
  stub payouts. Accepted: stub data only, no real money, no backend writes.
- G3: payouts API is JSON-only plus a read-only detail section; no HTML
  payout dashboard in v1. Accepted: the XSS rule (P4) is enforced at the
  JSON boundary and binds any future HTML view.
- G4: exactly-once release is per-process (double-release → 409 within a
  run; restart resets). Accepted: preview stub semantics, documented here.
