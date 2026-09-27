# Wayselect purchase-slice build spec — confirm + receipt, closing B7 (v2)

Status: buildable per Web Engineer verdict 2026-09-27 (confirmation `9aa8b162` ACCEPT, no follow-up
product questions) · CPO-owned requirements · rev 2 folds the three verdict corrections; probes are normative
Goal: [The TWO Community](/TOG/goals/61e06c97-e4f9-4c56-be57-6af9a2d70376) — smallest sellable purchase step after the buyer surface is specified.
Predecessors: [TOG-4869](/TOG/issues/TOG-4869) (buyer spec v1, in_review — this spec builds on rev 1) ·
[TOG-5010](/TOG/issues/TOG-5010) (merged web acceptance: field contract F1–F9, error states E1–E7, gating matrix) ·
[TOG-4882](/TOG/issues/TOG-4882) (shipped listing-detail + purchase stub) · [TOG-4916](/TOG/issues/TOG-4916) (blocked search/filter UI slice).

## 1. Context

[TOG-4869](/TOG/issues/TOG-4869) specified the buyer surface (5 listing fields → exact schema v1 keys,
purchase click-path listing → eligibility → confirm → receipt) and shipped `scripts/buyer-acceptance.sh`,
where step B7 (confirm + receipt surfaces) is specified-not-built by design. Its scale rule prescribes
exactly this card: *"first run green on B1–B6 → CPO writes the purchase-slice build spec (confirm/receipt
implementation closing B7)."* This spec is that build spec: an engineer implements the confirm page and the
receipt response from it with no further product questions. It is dry-run only: no charge, no payment
credentials, no persistence, no live routing.

Dependency (not a blocker): [TOG-4869](/TOG/issues/TOG-4869) v1 awaits CEO approval (confirmation `c36766e1`).
If approval changes v1, CPO revises this spec (G3). Spec work proceeds on rev 1; implementation waits for
both approvals plus COO admission via [TOG-4401](/TOG/issues/TOG-4401).

## 2. User story

As a buyer previewing a Wayselect listing, I want to confirm my pick on a page that restates exactly what
I saw, and receive a receipt that proves what was confirmed and when,
so I can trust the preview purchase path without entering payment details.

## 3. Non-goals / guardrails (not negotiable)

- Dry-run only: no charge, no payment credentials collected, no order persistence, no live routing.
  Any real-payment scope needs a separate CEO decision ([TOG-4869](/TOG/issues/TOG-4869) Q4, owner-reserved).
- Node 20+ ESM, stdlib only, thin preview server `web/server.js` (per CTO direction [TOG-4403](/TOG/issues/TOG-4403)).
- No compatibility, cost, or savings claims. Every price is a synthetic list-price estimate with the
  disclaimer adjacent (inherited from [TOG-5010](/TOG/issues/TOG-5010) F6).
- Preview-flag gating extends, never weakens: new surfaces are flag-gated; the unattested-POST 403
  (E3) is preserved byte-for-byte.
- Base: branch from `main`; rebase onto the [TOG-4916](/TOG/issues/TOG-4916) slice if it merges first
  (both touch `web/server.js`).

## 4. Requirements

- R1 Confirm page `GET /listings/:provider/:model/confirm` (flag-gated): restates every [TOG-5010](/TOG/issues/TOG-5010)
  F1–F9 field from the same listing data, **plus a provenance row** (`provenance.source` + `provenance.fetchedAt`,
  closing [TOG-5010](/TOG/issues/TOG-5010) G1 for this page), a dry-run notice ("No charge will be made. Confirm records
  preview intent only."), and exactly one form posting to `POST /listings/:p/:m/purchase` carrying the R3
  attestation as hidden fields. Unknown listing → 404 not-found pattern (E1). Flag off → 404 preview-disabled.
- R2 Eligibility note on the confirm page is a listing-derived capability summary (the four booleans +
  modalities, same Yes/No badges as F4) plus a pointer reading "Authoritative verdict: CLI dry-run explain
  (`bin/wayselect`)" (`bin/wayselect` is dry-run-only; its flags are `--catalog`/`--configuration`/`--request`,
  no `--dry-run` flag). The web does **not**
  gain an eligibility engine; the authoritative verdict stays CLI-side ([TOG-4836](/TOG/issues/TOG-4836),
  [TOG-4869](/TOG/issues/TOG-4869) step 2).
- R3 Confirmation attestation (stateless, no sessions/cookies/auth). The confirm form posts hidden fields
  `confirmed=true`, `priceInput`, `priceOutput` echoing the current `entry.cost` values verbatim
  (`"unpublished"` when cost is absent, per [TOG-4869](/TOG/issues/TOG-4869) D4). Server validates in order:
  attestation present → flag → listing exists → echo matches current listing (unattested POST with flag
  off is 403 per C4/R5, so attestation is checked first). Price-echo mismatch →
  `409` page "Confirmation does not match the current listing." Missing attestation → `403 preview_only`
  (E3, unchanged).
- R4 Receipt: an attested POST that passes R3 validation returns `200` with an HTML receipt page containing:
  title (`entry.name` + `entry.id`), seller (`providerId`), price as-quoted, capability summary,
  `provenance.source` + `provenance.fetchedAt`, server timestamp (ISO), the dry-run disclaimer
  ("No charge made. Intent recorded for preview only. No payment details collected. No persistence." — worded
  to pass the C12 `credential` substring grep),
  the preview banner, and a back-to-listings link. Receipts are rendered responses only — nothing is stored.
- R5 Unchanged contracts: unattested `POST …/purchase` → `403 preview_only` any flag state (E3 preserved);
  `GET …/purchase` → `405` (E4); unknown listing with attestation → `404`; attested POST with flag off →
  `404` preview-disabled (receipt is a preview surface).
- R6 Flag-gating matrix adds two rows to [TOG-5010](/TOG/issues/TOG-5010) §4: `GET …/confirm` → 200/404-not-found
  when on, 404 preview-disabled when off; attested `POST …/purchase` → 200 receipt when on,
  404 preview-disabled when off. All other rows unchanged.
- R7 XSS rule extends to both new surfaces: every dynamic value HTML-escaped; probe values
  (`<script>`, `<img src=x>`, quote-breakouts) never render raw on confirm or receipt pages.
- R8 No payment or credential fields anywhere: confirm and receipt pages contain no `password`/card inputs
  and no credential field names (assertable by grep, C12).
- R9 Docs: the build slice updates `docs/wayselect-web-acceptance.md` (§3 E3 note + new confirm/receipt section,
  keeping [TOG-5010](/TOG/issues/TOG-5010) the living web contract) and extends `bin/accept-wayselect-web` with
  the §5 probes at zero-skip. No CLI flags are added, so no `--help` change.

## 5. Acceptance probes (copy-paste; all must pass; stdlib only, ephemeral ports)

Follow the `bin/accept-wayselect-web` pattern (start the real server from `web/server.js` on, flag on and off):

- C1 `GET /listings/northstar/alpha-chat/confirm` (flag on) → 200; contains `<h1>Alpha Chat</h1>`,
  `northstar/alpha-chat`, price rows, provenance source + fetchedAt, dry-run notice, preview banner,
  exactly one form posting to `/listings/northstar/alpha-chat/purchase` with hidden `confirmed`,
  `priceInput`, `priceOutput`.
- C2 `GET /listings/northstar/nope/confirm` (flag on) → 404 not-found page + back link.
- C3 `GET …/confirm` (flag off) → 404 preview-disabled naming `WAYSELECT_PREVIEW`.
- C4 `POST …/purchase` without attestation → 403 `{error:"preview_only"}` on and off the flag (E3 preserved).
- C5 Attested POST (echo matches) → 200 receipt containing title, seller, price as-quoted, provenance
  source + fetchedAt, ISO timestamp, dry-run disclaimer, preview banner, back link.
- C6 Attested POST with tampered `priceInput` → 409 page naming the mismatch.
- C7 Attested POST to an unknown listing → 404.
- C8 Attested POST with flag off → 404 preview-disabled.
- C9 Evil listing values (`<script>`, quote-breakouts) never render raw on confirm or receipt pages.
- C10 `GET …/purchase` → 405 `{error:"method_not_allowed"}` (E4 preserved).
- C11 Two identical attested POSTs render byte-identical receipts except the timestamp line.
- C12 Confirm + receipt HTML contain no `type="password"`, `cardnumber`, `cvc`, or `credential` strings.
- B7-close (CLI): `scripts/buyer-acceptance.sh` B7 reports PASS — B7a confirm surface restates §2 fields,
  B7b receipt carries R4 fields, B7c unattested purchase refused — against the staging fixture
  ([TOG-4873](/TOG/issues/TOG-4873) endpoint).

## 6. Build slices for COO admission (each ≤4h, via [TOG-4401](/TOG/issues/TOG-4401))

- S1 Web confirm page (R1–R2, R6–R8) + unit tests (C1–C3, C9-part, C12-part). Owner: Web Engineer.
- S2 Receipt POST (R3–R5) + `accept:web` extension to zero-skip on C1–C12 + acceptance-doc update (R9).
  Owner: Web Engineer. Review: single Code Reviewer pass (no auth/sessions/secrets/payments in the diff;
  CISO only if credential/payment handling is added).
  Implementer notes (no spec change, from buildability verdict): add stdlib urlencoded body parsing with a
  byte cap (the server never reads request bodies today); keep the receipt timestamp on its own line so C11
  byte-identity holds; `CONFIRM_ROUTE` cannot collide with the 2-segment `LISTING_ROUTE`.
- S3 CLI B7 close: `buyer-acceptance.sh` B7 green on the staging fixture + README snippet. Owner: QA & Release Engineer.
- S4 QA gate: `npm run accept:web` green from a clean checkout; B7 staging run recorded on this card. Owner: QA.

## 7. Named gaps (not assumed)

- G1 Stub listings carry no `supportState`/`evidence`, so the web confirm page cannot show an authoritative
  eligibility verdict; the CLI explain remains authoritative (D2).
- G2 Stateless attestation means resubmission regenerates the receipt; harmless because nothing is stored
  and no charge exists. No idempotency-key machinery in this slice.
- G3 [TOG-4869](/TOG/issues/TOG-4869) v1 is unapproved; CEO changes to v1 propagate here via CPO revision.

## 8. Open questions (each with a named decider — no orphans)

- Q1 Receipt/intent persistence beyond render (server-side record)? Default: render-only. Decider: CTO & Chief AI Officer (persistence adds backend writes + CISO review).
- Q2 Staging endpoint + snapshot for the B7-close run? Decider: QA & Release Engineer (same as [TOG-4869](/TOG/issues/TOG-4869) Q6).
- Q3 (inherited) Real vs simulated purchase scope → CEO ([TOG-4869](/TOG/issues/TOG-4869) Q4, owner-reserved); this spec assumes dry-run-only.
- Q4 (inherited) Stale-catalog threshold (proposed 24h) → Founding Engineer ([TOG-4869](/TOG/issues/TOG-4869) Q3); confirm-time freshness re-checks reuse it.

## 9. Resolved decisions (CPO-owned requirements — no approval needed)

- D1 Scope is confirm + receipt implementation closing B7, not a payment build.
- D2 Web shows a listing-derived capability summary; authoritative eligibility stays CLI-side.
- D3 Stateless hidden-field echo attestation; no sessions, cookies, or auth accounts.
- D4 Render-only receipt; no persistence, no charge, no credentials.
- D5 E3/E4 preserved for unattested/GET purchase traffic; the gating matrix is extended, never weakened.
- D6 This spec builds on [TOG-4869](/TOG/issues/TOG-4869) rev 1; CPO revises if CEO changes v1.

## 10. Seven-day metric + kill/scale

- Metric (by 2026-10-03): one build slice (S1–S4) admitted by COO referencing this spec, or a B7-close run
  recorded against it — i.e. the spec is consumed by build within 7 days of approval.
- Kill rule: no consuming slice within 7 days of approval → spec returns to the CPO backlog; no further
  purchase-surface product work until COO confirms capacity.
- Scale rule: first consuming slice merged → the C1–C12 probes become a required gate (`npm run accept:web`
  zero-skip) for every subsequent web slice. Review date: 2026-10-03.
