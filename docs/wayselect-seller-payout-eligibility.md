# Wayselect seller payout-eligibility checklist (TOG-5490, part 4)

Standalone part 4. Part 3 ([TOG-5370](/TOG/issues/TOG-5370)) owns
**payout-status visibility** (listing payout fields, state transitions,
buyer/seller acceptance for payouts). This card owns **payout-eligibility**:
the preconditions a seller must satisfy before any payout-status transition
may apply. Deliverable: this spec plus
`bin/accept-wayselect-seller-payout` (`npm run accept:seller-payout`).
**No implementation**: `src/` and `web/` are untouched.

Non-goals (inherited): no live provider calls, no credentials, no network
access, no backend writes, no real money, prices, or payouts. All prices are
synthetic list-price estimates; all listings are stub data. The purchase
endpoint always refuses (`403 preview_only`), and payout-eligibility never
pays, charges, or writes — it is a read-only checklist ending at the stub.

## 0. No-overlap statement

This spec re-specs nothing shipped; every row below cites its owner:

| Existing contract | Owner | This spec |
| --- | --- | --- |
| Payout-status fields + transitions | [TOG-5370](/TOG/issues/TOG-5370) (part 3) | Cited; untouched — eligibility is the gate *before* any status transition |
| Seller offer/accept O0–O9, A1–A8 | [TOG-5142](/TOG/issues/TOG-5142) | Cited as the PE4 source; §2 mirrors its forward-contract shape |
| Seller-submission intake (codes, keys, provenance) | [TOG-4958](/TOG/issues/TOG-4958) spec / [TOG-5118](/TOG/issues/TOG-5118) validator | Cited as the PE1 source; no rule restated |
| CLI fail-closed eligibility E0–E9 | [TOG-5220](/TOG/issues/TOG-5220) | Cited as the PE3 reason-code vocabulary |
| Granted/Blocked/Unknown display derivation | TOG-5221 (`web/eligibility.js`) | Cited; PE3 adds the payout verdict mapping only |
| Purchase confirm / `unconfirmed` / 403 stub | [TOG-4869](/TOG/issues/TOG-4869) / [TOG-5123](/TOG/issues/TOG-5123) | Cited as the PE5 terminal-honesty source |
| Onboarding copy, P1 400 template, P3 no-explainer-page | [TOG-5229](/TOG/issues/TOG-5229) | Flag convention + fail-closed wording reused |
| Buyer shortlist SH0–SH10 forward shape | [TOG-5413](/TOG/issues/TOG-5413) | Mirrored for the §2 forward-route shape only |

## 1. Payout-eligibility checklist (requirements)

A seller is **payout-eligible** iff PE1 ∧ PE2 ∧ PE3 ∧ PE4 all hold. PE5 and
PE6 are invariant guards that hold on every run. There is no partial
eligibility: any unknown or missing input fails closed to **not eligible**,
never to eligible.

| # | Requirement | Rule | Probes | Status |
| --- | --- | --- | --- | --- |
| PE1 | Valid seller submission | `validateSellerSubmission` passes: frozen output, `routeId = providerId/modelId`, provenance `source` named on every rejection; executable location fields (`url`, `endpoint`, `baseUrl`, `apiUrl`) rejected at any depth | P1a–P1c | Runnable today |
| PE2 | Listed | The submission route resolves in the preview catalog (`getStubListing`); a valid-but-unlisted submission is **not eligible** (documented gap G1, not a script failure) | P2a–P2b | Runnable today |
| PE3 | Capability-eligible | Preview eligibility evaluates `eligible=true` (display Granted). Blocked (known exclusion) and Unknown (missing data) are both **not eligible** — unknown is never silently blocked and never granted | P3a–P3c | Runnable today |
| PE4 | Accepted offer | Exactly one accepted offer exists for the listing; siblings supersede (the [TOG-5142](/TOG/issues/TOG-5142) A1–A3 invariant). No accepted offer → `awaiting-offer`, not eligible | F1–F4 | Forward contract; script skips until the slices land |
| PE5 | Never pays | Eligibility changes nothing: `POST …/purchase` still refuses `403 preview_only` with the flag on and off. An eligible seller is payable-in-principle, never paid-by-this-slice | P5a–P5b | Runnable today |
| PE6 | Flag gating | Web-surface reads require `WAYSELECT_PREVIEW` on (truthy: `1`, `true`, `yes`, `on`; trimmed, case-insensitive). The pure validators (PE1, PE3) are flag-independent: identical input gives identical verdicts either way | P6a–P6b | Runnable today |

Verdict vocabulary (preview only): `eligible`, `awaiting-offer`,
`not-eligible:<reason>` (e.g. `not-eligible:unlisted`,
`not-eligible:missing-capability:toolUse`), where `<reason>` reuses the
existing evaluator reason codes verbatim.

## 2. Probe matrix (every requirement has a checkable probe)

### PE1 — submission probes (today)

| # | Input | Expected |
| --- | --- | --- |
| P1a | `fixtures/seller-submission.synthetic.json` → `valid` | Passes: frozen result + entry + provenance, `routeId=northstar/seller-chat`, `entry.name=Seller Chat`, `provenance.source=synthetic://wayselect/seller-fixture-v1` |
| P1b | Same fixture → `minimal` (unpublished price) | Passes: `routeId=northstar/price-unpublished`, `entry.cost=null`, `entry.status=null` |
| P1c | Four malformed variants | `missing-provenance`/`provenance` (source null); `forbidden-field`/`submission.url`; `id-mismatch`/`modelId`; `invalid-value`/`entry.cost.input` — each rejection names its key and provenance source |

### PE2 — listed probes (today)

| # | Input | Expected |
| --- | --- | --- |
| P2a | `getStubListing("northstar", "alpha-chat")` | Non-null, `entry.name=Alpha Chat` — the listed path |
| P2b | `getStubListing("northstar", "seller-chat")` + P1a result | Null (unlisted) while the submission itself validates → verdict `not-eligible:unlisted` (gap G1; the probe passes by asserting exactly this) |

### PE3 — capability probes (today)

| # | Input | Expected |
| --- | --- | --- |
| P3a | `evaluateListingEligibility(alpha-chat)` | `eligible=true`, no reasons, display Granted |
| P3b | `evaluateListingEligibility(image-lite)` | `eligible=false`, reasons include `unsupported-capability:toolUse`, display Blocked |
| P3c | `evaluateListingEligibility(unknown-tools)` | `eligible=false`, reasons include `missing-capability:toolUse`, display Unknown with not-selectable copy (fail closed) |

### PE4 — offer/payout forward contract (skip until the slices land)

Detected read-only: offers probes run only when
`GET /listings/northstar/alpha-chat/offers` returns a JSON `offers` array;
payout probes run only when
`GET /listings/:p/:m/payout-eligibility` returns a JSON body with a boolean
`eligible`. Otherwise each reports `SKIP` and the run still exits 0.

| # | Request (slice present) | Expected |
| --- | --- | --- |
| F1 | `GET /listings/northstar/alpha-chat/payout-eligibility` (flag on) | 200 JSON `{listing:"northstar/alpha-chat", eligible:boolean, checklist:{submission,listed,capability,offer}, reasons:[...]}` with no payment fields (no `amount`, `charge`, `paymentUrl`, or `url`-family keys anywhere in the body) |
| F2 | Same body | `eligible === (submission && listed && capability && offer)` — the route never invents eligibility the checklist denies |
| F3 | Same route (flag off) | 404 preview-disabled (HTML page or JSON `{error:"preview_disabled"}` — either passes if status is 404 and the body names the flag) |
| F4 | Offers invariant (offers slice present) | At most one accepted offer per listing; accepting one open offer supersedes its siblings (the [TOG-5142](/TOG/issues/TOG-5142) A1–A3 rule PE4 rests on) |

### PE5 / PE6 — guard probes (today)

| # | Request | Expected |
| --- | --- | --- |
| P5a | `POST /listings/northstar/alpha-chat/purchase` (flag on) | 403 JSON `{error:"preview_only"}` |
| P5b | Same (flag off) | 403 `preview_only` (ungated by design — a refuse-stub has no preview-only behavior to gate) |
| P6a | `GET /listings`, detail (flag off) | 404 preview-disabled page naming `WAYSELECT_PREVIEW` |
| P6b | `validateSellerSubmission(valid)` evaluated flag-on vs flag-off | Identical `routeId` — pure validators read no env, so the flag cannot change PE1/PE3 verdicts |

## 3. Runnable acceptance script (under 15 minutes)

```sh
node --version                # 20+
npm run accept:seller-payout  # this acceptance script, typically < 5s
npm test                      # regression: full suite still green
```

`bin/accept-wayselect-seller-payout` (zero dependencies, stdlib only plus
the real `src/sellerSubmission.js`, `web/server.js`, `web/stub-listing.js`,
and `web/eligibility.js` boundaries — no new product code) checks §2:
P-probes against the current tree, F-probes only when their slice is
present. Expected tail output today:

```
SUMMARY: 12 pass, 0 fail, 4 skip — 0.0s (budget 15m)
```

Exit code is 0 with zero failures (skips allowed), 1 otherwise. The payout
slice is accepted when the same command reports zero skips and zero fails.

QA end-to-end (reviewer-checkable, no setup beyond a clean checkout):

1. `node --version` → 20+ (else FAIL).
2. `npm run accept:seller-payout` → exit 0, note pass/fail/skip counts.
3. `npm test` → exit 0 (no regression).
4. Report: paste the `SUMMARY:` line plus any `FAIL` lines as the pass/fail
   record. Skips are expected until the offers/payout slices land; any FAIL
   is a rejection.

## 4. Sign-off, metric, kill/scale

- [ ] Engineer: script executes end-to-end in under 15 minutes on a clean checkout.
- [ ] QA: pass/fail/skip semantics independently reproducible (`npm run accept:seller-payout`).
- [ ] Code Reviewer: one pass on the script + doc (docs + test-script-only change; no Security/CISO/QA review — no auth, secrets, payments, or public exposure in the diff).

Seven-day metric (by 2026-10-04): script executed (0 fail) against the
current tree (baseline green, forward skips allowed) and cited by the next
seller/payout build slice — 1 accepted script. Kill rule: if no offers or
payout slice lands to execute F1–F4 against within 14 days, archive §2-PE4
instead of maintaining it. Scale rule: once executed green with zero skips,
`npm run accept:seller-payout` becomes a required gate for every subsequent
seller/payout slice. Review date: 2026-10-04.

## 5. Accepted gaps

- G1: the fixture seller `northstar/seller-chat` validates but is not a stub
  listing, so P2b asserts `not-eligible:unlisted`. Accepted: the probe pins
  the gap instead of failing on it; a slice that lists seller submissions
  flips P2b to the listed path in place.
- G2: offers and payout-eligibility routes are unbuilt, so F1–F4 skip.
  Accepted: detection is read-only (a 404 shaped like today's unknown-path
  JSON skips; only a 200 with the contracted shape runs).
- G3: there is no payout rail and none is specified here — eligibility never
  implies payment, and F1 rejects payment-shaped fields. Accepted: keeps this
  card inside the preview-only, no-money boundary.
- G4: no seller auth in v1 (inherited from [TOG-5142](/TOG/issues/TOG-5142)
  G2). Accepted: stub data only, no real money, no backend writes.
