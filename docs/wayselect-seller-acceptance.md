# Wayselect seller acceptance: list → offer → accept (TOG-5142)

Merged product spec and executable acceptance for the next Wayselect seller
slice behind `WAYSELECT_PREVIEW`. Slice status:

| Step | Meaning | Card | Status |
| --- | --- | --- | --- |
| List | Seller verifies their listing is visible in `GET /listings` + detail | TOG-4882 (shipped) | Baseline, covered today |
| Offer | Buyer posts a stub offer on a listing | — (next slice) | Forward contract only (§2); script auto-skips until it lands |
| Accept | Seller accepts one offer; others supersede | — (next slice) | Forward contract only (§3); script auto-skips until it lands |

Non-goals (inherited): no live provider calls, no credentials, no backend
writes beyond in-memory stub state, no real prices, no auth, no persistence
across restarts. All prices are synthetic list-price estimates; all listings
are stub data. The purchase endpoint always refuses (`403 preview_only`).

## 1. List step contract (baseline, runnable today)

The seller flow starts from the shipped listing slice. These rows must pass
today and after the seller slice lands (no regression).

| # | Request | Expected |
| --- | --- | --- |
| L0 | `GET /listings` (flag on) | 200, contains every stub listing in stub order (e.g. `Alpha Chat`) |
| L0b | `GET /listings/northstar/alpha-chat` (flag on) | 200 detail page with `Alpha Chat` |
| P0 | `POST /listings/northstar/alpha-chat/purchase` | 403 JSON `{error:"preview_only"}` — seller flow never turns the purchase stub into a real charge |

## 2. Offer step contract (forward contract for the next slice)

New JSON-only stub routes, all flag-gated, all in-memory (restart clears).
No auth in v1: seller identity is stubbed.

| # | Request | Expected |
| --- | --- | --- |
| O0 | `GET /listings/northstar/alpha-chat/offers` (flag on, fresh server) | 200 JSON `{listing:"northstar/alpha-chat", offers:[]}` — empty initially |
| O1 | `POST /listings/northstar/alpha-chat/offers` with `{"buyer":"mia","price":12}` | 201 JSON `{id:"offer-1", listing:"northstar/alpha-chat", buyer:"mia", price:12, status:"open"}` |
| O2 | `GET /listings/northstar/alpha-chat/offers` after O1 | 200, `offers` contains `offer-1` with `status:"open"` |
| O3 | `GET /listings/northstar/alpha-chat/offers/offer-1` | 200 single offer, `status:"open"` |
| O4 | `POST …/offers` with missing/negative/NaN/string price | 400 JSON `{error:"invalid_offer", …}` naming valid values (fail closed, never default) |
| O5 | `POST …/offers` with missing/blank/overlong buyer (>120 chars) | 400 `invalid_offer` naming valid values |
| O6 | `POST /listings/northstar/nope/offers` with valid body | 404 JSON `{error:"not_found"}` |
| O7 | `GET /listings/northstar/nope/offers` | 404 JSON `{error:"not_found"}` |
| O8 | `POST …/offers` with malformed JSON or wrong `Content-Type` | 400 `invalid_offer` (fail closed) |
| O9 | `POST …/offers` with evil buyer `<script>alert(1)</script>` | 201 accepted as data, but never renders raw: JSON body is safely encoded and any future HTML offers view must HTML-escape it |

Request shape (v1): `Content-Type: application/json`,
`{buyer: string (trimmed, 1–120 chars), price: number (finite, >= 0)}`.
Unknown fields → `400 invalid_offer`. Offer IDs are deterministic per
listing per process: `offer-1`, `offer-2`, … Reset on restart (documented
gap G2, not a failure).

## 3. Accept step contract (forward contract for the next slice)

| # | Request | Expected |
| --- | --- | --- |
| A1 | `POST /listings/northstar/alpha-chat/offers/offer-1/accept` (open offer) | 200 JSON `{id:"offer-1", status:"accepted", …}` |
| A2 | `GET …/offers/offer-1` after A1 | 200, `status:"accepted"` |
| A3 | Second offer (`offer-2`, created before accept) after A1 | 200, `status:"superseded"` (exactly one accepted per listing) |
| A4 | `POST …/offer-1/accept` again (double-accept) | 409 JSON `{error:"offer_conflict", …}` |
| A5 | `POST …/offers/offer-999/accept` (unknown offer) | 404 JSON `{error:"not_found"}` |
| A6 | `POST /listings/northstar/nope/offers/offer-1/accept` | 404 JSON `{error:"not_found"}` |
| A7 | `GET …/offers/offer-1/accept` | 405 JSON `{error:"method_not_allowed"}` |
| A8 | `POST …/purchase` after accept | Still 403 `preview_only` — accepting a stub offer never performs a purchase or backend write |

Accept request body: empty (no fields required in v1). Accepting a
`superseded` offer → `409 offer_conflict`. Once one offer is accepted,
accepting any other open offer on the same listing → `409`.

## 4. Flag-gating and error matrix

`WAYSELECT_PREVIEW` truthy values (trimmed, case-insensitive): `1`,
`true`, `yes`, `on`. Anything else, including unset, is off.

| Route | Flag on | Flag off |
| --- | --- | --- |
| `GET /listings`, `GET /listings/:p/:m` | 200, or 404 not-found | 404 preview-disabled page |
| `GET /listings/:p/:m/offers`, `GET …/offers/:id` | 200 JSON, or 404 not-found | 404 preview-disabled (HTML page or JSON `{error:"preview_disabled"}` — either passes if status is 404 and body names the flag) |
| `POST …/offers`, `POST …/offers/:id/accept` | 201/200, or 4xx per §2–§3 | 404 preview-disabled (`{error:"preview_disabled"}` or HTML naming the flag) |
| `POST …/purchase` | 403 `preview_only` | 403 `preview_only` (ungated by design) |
| Anything else | 404 JSON `{error:"not_found"}` | 404 JSON `{error:"not_found"}` |

## 5. Runnable acceptance script (under 15 minutes)

```sh
node --version            # 20+
npm run accept:seller     # this acceptance script, typically < 5s
npm run accept:web        # regression: listing slice still green
```

`bin/accept-wayselect-seller` (zero dependencies, stdlib only) starts the
real server on ephemeral ports and checks §1 against the shipped slice.
Sections §2–§4 seller probes run only when the seller slice is present;
until then they report `SKIP (seller slice not present)` and the run still
exits 0. Expected tail output today:

```
SUMMARY: 3 pass, 0 fail, 21 skip — 0.0s (budget 15m)
```

Exit code is 0 with zero failures (skips allowed), 1 otherwise. The next
slice is accepted when the same command reports zero skips and zero fails.

QA end-to-end (reviewer-checkable, no setup beyond a clean checkout):

1. `node --version` → 20+ (else FAIL).
2. `npm run accept:seller` → exit 0, note pass/fail/skip counts.
3. `npm run accept:web` → exit 0 (no regression).
4. Report: paste the two `SUMMARY:` lines plus any `FAIL` lines as the
   pass/fail record. Skips are expected until the seller slice lands;
   any FAIL is a rejection.

## 6. Sign-off, metric, kill/scale

- [ ] Engineer: script executes end-to-end in under 15 minutes against the next seller slice.
- [ ] QA: pass/fail/skip semantics independently reproducible (`npm run accept:seller` from a clean checkout).

Seven-day metric (by 2026-10-03): script executed (0 fail) against the
current tree (baseline green, seller skips allowed) — 1 accepted script.
Kill rule: if no seller slice lands to execute §2–§3 against within 14
days, archive §2–§3 instead of maintaining them. Scale rule: once executed
green with zero skips, `npm run accept:seller` becomes a required gate for
every subsequent seller/marketplace slice. Review date: 2026-10-03.

## 7. Accepted gaps

- G1: offers are in-memory only; a server restart clears them. Accepted:
  the script uses a fresh ephemeral server per run, so IDs are
  deterministic (`offer-1`, …) within the run.
- G2: no seller auth in v1; anyone with the preview flag can post/accept
  stub offers. Accepted: stub data only, no real money, no backend writes.
- G3: offers API is JSON-only; no HTML offers dashboard in v1. Accepted:
  XSS rule (O9) is enforced at the JSON boundary and binds any future HTML
  view.
