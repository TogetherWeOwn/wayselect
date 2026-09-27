# Wayselect seller acceptance: list → offer → accept (TOG-5142)

Merged product spec and executable acceptance for the next Wayselect seller
slice behind `WAYSELECT_PREVIEW`. Slice status:

| Step | Meaning | Card | Status |
| --- | --- | --- | --- |
| List | Seller verifies their listing is visible in `GET /listings` + detail | TOG-4882 (shipped) | Baseline, covered today |
| Offer | Buyer posts a stub offer on a listing | — (next slice) | Forward contract only (§2); script auto-skips until it lands |
| Accept | Seller accepts one offer with the §2A stub token; others supersede | TOG-5474 (S1 design, this doc) | Design accepted here; implementation forward contract (§2A + §3); script auto-skips until it lands |

Non-goals (inherited): no live provider calls, no real credentials, no backend
writes beyond in-memory stub state, no real prices, no real auth, no persistence
across restarts. Preview seller identity is a documented stub token for the
accept route only (§2A); it confers no rights beyond localhost preview.
All prices are synthetic list-price estimates; all listings
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
Buyer offer posts are unauthenticated by design (buyer identity is the
`buyer` body field). Seller accept requires the §2A stub token — this
retires the old "no auth in v1" acceptance (G2).

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
listing per process: `offer-1`, `offer-2`, … Reset on restart (in-memory
is gap G1, not a failure).

## 2A. Preview seller identity — stub token (S1, TOG-5474)

Buyer offer posts stay unauthenticated by design (buyer identity is the
`buyer` body field). The state-changing seller step — `POST
…/offers/:id/accept` — requires a documented stub token. This retires the
old "no auth in v1" acceptance (G2): anyone with the preview flag could
post offers, but only a caller presenting the seller stub token can accept
one. The token confers no rights beyond localhost preview; it is not a
secret and must never be reused as real auth.

- Token value (fixed, documented, no entropy claim): `preview-seller-1`.
- Transport: `Authorization: Bearer preview-seller-1` header on the accept
  route only. Exact match (trimmed, case-sensitive scheme `Bearer` +
  single space + token). No query-param, cookie, or alternate header
  accepted. Reads (`GET …/offers`, `GET …/offers/:id`) stay flag-gated
  with no token, so the seller dashboard read path keeps working.
- Fail closed: missing header, wrong scheme, empty/wrong token, or extra
  surrounding content → `401 JSON {error:"seller_unauthorized", …}`
  naming the expected scheme (Bearer) and where the token is documented
  (§2A), never echoing the presented value.
- Precedence (accept route): flag-gate first → listing/offer existence →
  auth → state conflict. Flag off returns 404 `preview_disabled` even
  with a valid token; unknown listing/offer returns 404 `not_found` even
  with a valid token; only an existing open offer with a valid token can
  reach 200/409.
- Token never unlocks anything else: `POST …/purchase` stays
  `403 preview_only` with or without the token; offer posts ignore the
  header entirely.
- Scope guard: the stub token dies with the persistent/monetized slice.
  Any seller slice that persists across restarts or moves money must
  replace `preview-seller-1` with real seller auth first; until S1's
  accept slice lands, preview stays localhost-only, stub data, purchase
  403 (TOG-5465 §1 A6 conditions).

## 3. Accept step contract (forward contract for the next slice)

| # | Request | Expected |
| --- | --- | --- |
| A0 | `POST …/offers/offer-1/accept` with no `Authorization` header (flag on, open offer) | 401 JSON `{error:"seller_unauthorized", …}` — fail closed, no state change; offer stays `open` |
| A0b | `POST …/offers/offer-1/accept` with wrong token or wrong scheme (e.g. `Token …`, `Bearer wrong`) | 401 `seller_unauthorized`, no state change |
| A0c | `POST …/offers/offer-1/accept` with valid token but flag off | 404 `preview_disabled` (flag gate runs before auth) |
| A0d | `POST …/purchase` with valid seller token | Still 403 `preview_only` — the stub token never unlocks purchase |
| A1 | `POST /listings/northstar/alpha-chat/offers/offer-1/accept` with valid token (open offer) | 200 JSON `{id:"offer-1", status:"accepted", …}` |
| A2 | `GET …/offers/offer-1` after A1 | 200, `status:"accepted"` |
| A3 | Second offer (`offer-2`, created before accept) after A1 | 200, `status:"superseded"` (exactly one accepted per listing) |
| A4 | `POST …/offer-1/accept` with valid token again (double-accept) | 409 JSON `{error:"offer_conflict", …}` |
| A5 | `POST …/offers/offer-999/accept` with valid token (unknown offer) | 404 JSON `{error:"not_found"}` |
| A6 | `POST /listings/northstar/nope/offers/offer-1/accept` with valid token | 404 JSON `{error:"not_found"}` |
| A7 | `GET …/offers/offer-1/accept` | 405 JSON `{error:"method_not_allowed"}` |
| A8 | `POST …/purchase` after accept (with or without token) | Still 403 `preview_only` — accepting a stub offer never performs a purchase or backend write |

All A-rows except A0/A0b/A0c assume `Authorization: Bearer
preview-seller-1` (§2A). 401s never change state: a follow-up `GET
…/offers/offer-1` still reads `open`.

Accept request body: empty (no fields required in v1). Accepting a
`superseded` offer with a valid token → `409 offer_conflict`. Once one
offer is accepted, accepting any other open offer on the same listing
with a valid token → `409`.

## 4. Flag-gating and error matrix

`WAYSELECT_PREVIEW` truthy values (trimmed, case-insensitive): `1`,
`true`, `yes`, `on`. Anything else, including unset, is off.

| Route | Flag on | Flag off |
| --- | --- | --- |
| `GET /listings`, `GET /listings/:p/:m` | 200, or 404 not-found | 404 preview-disabled page |
| `GET /listings/:p/:m/offers`, `GET …/offers/:id` | 200 JSON, or 404 not-found | 404 preview-disabled (HTML page or JSON `{error:"preview_disabled"}` — either passes if status is 404 and body names the flag) |
| `POST …/offers` | 201, or 4xx per §2 (no token; buyer identity is the body field) | 404 preview-disabled (`{error:"preview_disabled"}` or HTML naming the flag) |
| `POST …/offers/:id/accept` | 200/409 with valid §2A token; 401 `seller_unauthorized` without it; 404 `not_found` for unknown listing/offer (even with token) | 404 preview-disabled (flag gate runs before auth, even with token) |
| `POST …/purchase` | 403 `preview_only` (with or without seller token) | 403 `preview_only` (ungated by design) |
| Anything else | 404 JSON `{error:"not_found"}` | 404 JSON `{error:"not_found"}` |

## 4A. Error-envelope parity: seller intake vs purchase stub (R4-31)

Gap [TOG-6737](/TOG/issues/TOG-6737): `POST /sellers/submissions` returns a
diagnostic envelope (`error` + `code`/`key`/`source` + `message`) while
`POST /listings/:p/:m/purchase` returns a fixed refusal shape
(`error` + `message`, no `code`/`key`/`source`) with no documented reason.
This note pins both shapes to code so a reviewer can check the mapping
without reading source.

### HTTP-layer envelopes

| # | Case | Seller intake (`POST /sellers/submissions`, `web/server.js:373-428`) | Purchase stub (`POST …/purchase`, `web/server.js:338-366`) | Why they differ |
| --- | --- | --- | --- | --- |
| E1 | Wrong method | `405 {error:"method_not_allowed"}`, no `Allow` header (`:374-377`) | `405 {error:"method_not_allowed"}` with `Allow: POST` via `sendMethodNotAllowed` (`:340-343`, helper `:159-167`) | Incidental asymmetry: only the purchase path uses the shared 405 helper. No client should rely on the difference. |
| E2 | Preview flag off | `404 {error:"preview_disabled"}` — intake is flag-gated (`:378-381`) | `403 preview_only` in both flag states — the stub is intentionally ungated | A refuse-stub has no preview-only behavior to gate; intake does. |
| E3 | Unreadable body | Transport envelope (400, 413 for oversize, 408 for timeout): `{error:<transport code>, key:"submission", source:null, message}` (`:382-394`); `<transport code>` is one of `wrong_content_type`, `malformed_json`, `body_too_large`, `body_timeout` (`web/jsonBody.js:64,76,84,114`) | No body is read — n/a | Only intake accepts a body, so only intake has a transport layer. |
| E4 | Domain validation failure | Diagnostic envelope `400 {error:"invalid_submission", code, key, source, message}` (`:396-416`); `code`/`key`/`source` come verbatim from `SellerSubmissionError` (`src/sellerSubmission.js:63-71`); browsers get the same fields as the HTML rejection page (`web/seller.js:313`) | n/a — the stub never validates | Intake must tell the seller *what* to fix (defect class + dotted key path + provenance); a stub that never accepts input has nothing to diagnose. |
| E5 | Unknown listing | n/a (intake is not per-listing) | `404 {error:"listing_not_found"}` — undecodable segments or no stub match (`:349-358`) | Purchase is addressed at a listing; intake creates one. |
| E6 | Known listing | n/a | `403 {error:"preview_only", message:"Purchases are disabled in preview. No backend writes."}` (`:360-364`) — never writes, always refuses | Default-deny: no purchase path performs a charge in preview. |
| E7 | Success | `200` confirm model + `confirmPath` (`:418-426`) | No success shape exists | Intake stages an intent; the stub has no success state. |

### Validator vocabularies (library layer, `src/`)

Both validators throw the same triple — a stable `code`, the offending
dotted `key` path, and the provenance `source` — on identically-shaped
error classes (`SellerSubmissionError`, `src/sellerSubmission.js:63-71`;
`PurchaseSubmissionError`, `src/purchase.js:39-47`). Only the seller
validator is wired to HTTP (`web/server.js:396-416`); the purchase
validator runs CLI-side only (`bin/accept-wayselect-buyer-listing:29,219,238`,
`bin/accept-wayselect-checkout:37,145,208`).

| `code` | Seller intake | Purchase validator | Meaning |
| --- | --- | --- | --- |
| `invalid-type` | yes | yes | Wrong JSON type (object/boolean expected) |
| `missing-field` | yes | yes | Required field absent or blank (purchase: incl. `confirm`) |
| `invalid-value` | yes | yes | Present but out of range/pattern (caps, slug ids, dates, provenance) |
| `unknown-field` | yes | yes | Extra key at any level (`additionalProperties: false`) |
| `forbidden-field` | yes (`src/sellerSubmission.js:156`) | yes (`src/purchase.js:117`) | Executable location field (`url`/`endpoint`/`baseUrl`/`apiUrl`) at any depth |
| `missing-provenance` | yes (`src/sellerSubmission.js:430`) | yes (`src/purchase.js:233`) | `provenance` envelope absent |
| `id-mismatch` | yes (`src/sellerSubmission.js:463`) — `modelId` must equal `entry.id` | — | Seller-only cross-check (SG2 interim convention) |
| `unconfirmed` | — | yes (`src/purchase.js:144`) — `confirm:false` never proceeds | Purchase-only guard: the click-path confirm step |

### Why they differ (rationale)

1. **Different jobs.** Intake is a fix-and-resubmit loop: the seller needs
   the defect class (`code`), the exact location (`key`), and the data
   source (`source`) to correct the submission. The purchase stub is a
   default-deny endpoint: it takes no body, makes no decision, and writes
   nothing, so a fixed `{error, message}` refusal is the whole contract.
2. **Library parity already exists where it matters.** Both validators
   share the `code`/`key`/`source` triple and six of eight codes, so a
   future purchase route that accepts a body can reuse the intake mapping
   verbatim (transport codes → `error`, validator codes → `code`).
3. **No HTTP purchase validation exists to map.** `validatePurchaseSubmission`
   is exercised by the buyer/checkout acceptance scripts, never by
   `web/server.js` (no reference to it there). Documenting a purchase
   `code`/`key`/`source` HTTP shape today would describe code that cannot run.
4. **Forward rule.** If a purchase route ever accepts a JSON body, it MUST
   go through `readJsonBody` first and map `PurchaseSubmissionError` to
   `{error, code, key, source, message}` exactly as `:403-408` does (with a
   route-appropriate `error` name), so the two envelopes converge instead
   of drifting again.

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
- G2 (RETIRED by S1, TOG-5474): the old "no auth in v1 — anyone with
  the preview flag can post/accept stub offers" acceptance is withdrawn.
  Buyer offer posts stay unauthenticated by design, but the accept route
  requires the §2A stub token (`Authorization: Bearer preview-seller-1`,
  401 `seller_unauthorized` fail-closed). Until the §2A/§3 accept slice
  lands, the TOG-5465 §1 A6 conditions hold: preview localhost-only,
  stub data, purchase stays 403. Any persistent/monetized seller slice
  must replace the stub token with real seller auth first.
- G3: offers API is JSON-only; no HTML offers dashboard in v1. Accepted:
  XSS rule (O9) is enforced at the JSON boundary and binds any future HTML
  view.
