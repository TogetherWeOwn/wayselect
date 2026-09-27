# Wayselect buyer activation spec: search → compare → shortlist (TOG-5413)

Merged product spec and executable acceptance for the Wayselect buyer
first-value path behind `WAYSELECT_PREVIEW`. Moment status:

| Moment | Meaning | Status |
| --- | --- | --- |
| Search (M1) | Buyer finds candidate listings on `GET /listings` | Baseline runnable today (§1); filter behavior is a forward contract citing the web spec |
| Compare (M2) | Buyer evaluates one listing: detail fields + eligibility reasons | Fully runnable today (§2); no forward additions in this slice |
| Shortlist (M3) | Buyer keeps candidates across views | Forward contract only (§3); script auto-skips until it lands |

Non-goals (inherited): no live provider calls, no credentials, no backend
writes beyond in-memory stub state, no real prices, no auth, no persistence
across restarts. All prices are synthetic list-price estimates; all listings
are stub data. The purchase endpoint always refuses (`403 preview_only`).

## 0. No-overlap statement

[TOG-5370](/TOG/issues/TOG-5370) (part-3 spec) covers **seller**
payout-status visibility: listing payout fields, payout state transitions,
buyer/seller acceptance for payouts. This spec covers **no payout field, no
payout transition, no seller surface**. It re-specs nothing shipped:

| Existing contract | Owner | This spec |
| --- | --- | --- |
| Listing-detail fields F1–F9, empty/error states, flag matrix | TOG-4882 / [TOG-5010](/TOG/issues/TOG-5010) | Cited, not repeated (§2 pins the buyer-readable subset only) |
| Granted/Blocked/Unknown badge derivation | TOG-5221 | Cited; §2 adds the index↔detail **consistency** check no script runs today |
| Search/filter S1–S12 forward contract | [TOG-5010](/TOG/issues/TOG-5010) | Cited; §1 adds badge-preservation only |
| CLI fail-closed eligibility E0–E9 | [TOG-5220](/TOG/issues/TOG-5220) | Cited as reason-code vocabulary source |
| Seller offer/accept O0–O9, A1–A8 | [TOG-5142](/TOG/issues/TOG-5142) | Untouched; §3 mirrors its forward-contract shape for shortlist |
| Onboarding copy + P1 400 template + P3 no-explainer-page | [TOG-5229](/TOG/issues/TOG-5229) | Pinned decisions reused (§1, §2) |

## 1. M1 — search: find candidates (baseline today, filters forward)

Today search = the unfiltered index. These rows must pass today and after
every later slice (no regression).

| # | Request | Expected |
| --- | --- | --- |
| B1 | `GET /listings` (flag on) | 200, contains `Alpha Chat`, `Image Lite`, `Unknown Tools` |
| B2 | same | Stub order preserved (`Alpha Chat` before `Image Lite` before `Unknown Tools`; deterministic, no re-ranking) |
| B3 | same | Per-listing eligibility badge: `Alpha Chat` → Granted, `Image Lite` → Blocked, `Unknown Tools` → Unknown (fail-closed vocabulary) |
| B4 | same | Every listing item links to its detail page (`/listings/<p>/<m>`) |

Forward contract (next search/filter slice; owned with the web spec —
[S2–S12](/TOG/issues/TOG-5010) stay the source of truth there, cited here):

| # | Request | Expected |
| --- | --- | --- |
| F1 | `GET /listings?q=alpha` (slice present) | 200, keeps matching listings **with their badges intact** (filtering never drops or recomputes badge state) |
| F2 | `GET /listings?q=zzz-no-such-listing` (slice present) | 200, `No listings match these filters.` + `Clear filters` link to `/listings` |
| F3 | `GET /listings?capability=__bogus__` (slice present) | 400 page per the pinned P1 template (H1 `Invalid filter`, names valid values; fail closed, never ignore) |

## 2. M2 — compare: evaluate one listing (runnable today)

The buyer compares by opening detail pages. The eligibility section is the
only place first-run buyers meet exclusion reasoning (P3: no separate
explainer page — reason codes render verbatim in `<code>`).

| # | Request | Expected |
| --- | --- | --- |
| B5 | Each `B4` href (flag on) | 200 with the matching `<h1>` (`Alpha Chat`, `Image Lite`, `Unknown Tools`) |
| B6 | Index badge vs detail badge, per listing | Identical state (Granted/Blocked/Unknown) — the index never promises what the detail retracts |
| B7 | Detail Eligibility section, per listing | `aria-label="Eligibility"` section with badge + headline; `alpha-chat` Granted with no reasons; `image-lite` Blocked with `<code>unsupported-capability:toolUse</code>`; `unknown-tools` Unknown with `<code>missing-capability:toolUse</code>` and not-selectable copy |

Pinned buyer-readable detail subset (quoted from shipped code, not re-spec'd):
title + `Listing <code>p/m</code>` + provider name, four capability rows
(Yes/No/Unknown badges, never a silent default), input/output modalities,
`$X per 1M tokens` rows with the synthetic-only disclaimer, preview banner,
disabled purchase CTA, `Back to listings` link.

No forward additions for compare in this slice: any future side-by-side
compare view is explicitly out (smallest sellable).

## 3. M3 — shortlist: keep candidates (forward contract for the next slice)

New JSON-only stub routes, all flag-gated, all in-memory (restart clears).
No auth in v1: buyer identity is stubbed. Mirrors the seller offer/accept
contract shape ([TOG-5142](/TOG/issues/TOG-5142) §2–§3).

| # | Request | Expected |
| --- | --- | --- |
| SH0 | `GET /shortlist` (flag on, fresh server) | 200 JSON `{shortlist:[]}` — empty initially |
| SH1 | `POST /shortlist` with `{"provider":"northstar","model":"alpha-chat"}` | 201 JSON `{id:"short-1", listing:"northstar/alpha-chat", status:"saved"}` |
| SH2 | `GET /shortlist` after SH1 | 200, contains `short-1` with `status:"saved"` |
| SH3 | `GET /shortlist/short-1` | 200 single entry, `status:"saved"` |
| SH4 | `POST /shortlist` with missing/blank/overlong (>120 chars) provider/model, or unknown fields | 400 JSON `{error:"invalid_shortlist", …}` naming valid values (fail closed, never default) |
| SH5 | `POST /shortlist` with a valid shape but unknown listing | 404 JSON `{error:"not_found"}` (only real stub listings can be kept) |
| SH6 | `DELETE /shortlist/short-1` then `GET /shortlist/short-1` | 200 `{id:"short-1", status:"removed"}` then 404 `{error:"not_found"}`; repeat delete → 404 |
| SH7 | `GET /shortlist/short-999` / `DELETE …/short-999` | 404 JSON `{error:"not_found"}` |
| SH8 | `POST /shortlist` with malformed JSON or wrong `Content-Type` | 400 `invalid_shortlist` (fail closed) |
| SH9 | Any `/shortlist` route with the flag off | 404 preview-disabled (HTML page or JSON `{error:"preview_disabled"}` — either passes if status is 404 and body names the flag) |
| SH10 | `POST …/purchase` after SH1 | Still 403 `preview_only` — keeping a stub shortlist never performs a purchase or backend write |

Request shape (v1): `Content-Type: application/json`,
`{provider: string (trimmed, 1–120 chars), model: string (trimmed, 1–120
chars)}`. Unknown fields → `400 invalid_shortlist`. Entry IDs are
deterministic per process: `short-1`, `short-2`, … Reset on restart. No HTML
shortlist view in v1 (JSON-only); the XSS rule binds at the JSON boundary
and any future HTML view must HTML-escape stored values.

## 4. Terminal honesty (every moment ends here)

| # | Request | Expected |
| --- | --- | --- |
| B8 | Detail purchase CTA + `POST /listings/northstar/alpha-chat/purchase` (flag on and off) | Disabled button (`disabled` + `aria-disabled`); 403 JSON `{error:"preview_only"}` in both flag states — no buyer path ever performs a charge |
| B9 | `GET /listings`, detail (flag off) | 404 preview-disabled page naming `WAYSELECT_PREVIEW` |

## 5. Runnable acceptance script (under 15 minutes)

```sh
node --version            # 20+
npm run accept:buyer      # this acceptance script, typically < 5s
npm run accept:web        # regression: listing slice still green
npm run accept:seller     # regression: seller baseline still green
```

`bin/accept-wayselect-buyer` (zero dependencies, stdlib only) starts the
real server on ephemeral ports and checks §1 baseline (B1–B4), §2 (B5–B7),
and §4 (B8–B9) against the shipped slice. Section §1-forward (F1–F3) probes
run only when the search/filter slice is present; §3 probes run only when
the shortlist slice is present; until then they report
`SKIP (… slice not present)` and the run still exits 0. Expected tail output
today:

```
SUMMARY: 14 pass, 0 fail, 14 skip — 0.0s (budget 15m)
```

Exit code is 0 with zero failures (skips allowed), 1 otherwise. The next
slices are accepted when the same command reports zero skips for their rows
and zero fails.

QA end-to-end (reviewer-checkable, no setup beyond a clean checkout):

1. `node --version` → 20+ (else FAIL).
2. `npm run accept:buyer` → exit 0, note pass/fail/skip counts.
3. `npm run accept:web && npm run accept:seller` → exit 0 (no regression).
4. Report: paste the three `SUMMARY:` lines plus any `FAIL` lines as the
   pass/fail record. Skips are expected until the search/shortlist slices
   land; any FAIL is a rejection.

## 6. Sign-off, metric, kill/scale

- [ ] Engineer: script executes end-to-end in under 15 minutes against the next search/shortlist slice.
- [ ] QA: pass/fail/skip semantics independently reproducible (`npm run accept:buyer` from a clean checkout).
- [ ] Code Reviewer: one pass on the script + doc (docs + test-script-only change; no Security/CISO/QA review — no auth, secrets, payments, or public exposure in the diff).

Seven-day metric (by 2026-10-04): script executed (0 fail) against the
current tree (baseline green, forward skips allowed) and cited by the next
Wayselect build slice — 1 accepted script. Kill rule: if no shortlist slice
lands to execute §3 against within 14 days, archive §3 instead of
maintaining it. Scale rule: once executed green with zero skips,
`npm run accept:buyer` becomes a required gate for every subsequent
buyer/marketplace slice. Review date: 2026-10-04.

## 7. Accepted gaps

- G1: shortlist entries are in-memory only; a server restart clears them.
  Accepted: the script uses a fresh ephemeral server per run, so IDs are
  deterministic (`short-1`, …) within the run.
- G2: no buyer auth in v1; anyone with the preview flag can save/remove stub
  entries. Accepted: stub data only, no real money, no backend writes.
- G3: shortlist API is JSON-only; no HTML shortlist view in v1. Accepted:
  the XSS rule binds at the JSON boundary for any future view.
- G4: filter rows F1–F3 cite the web spec's S-rows rather than duplicating
  them; if the web spec's §2 changes, this spec follows it.
