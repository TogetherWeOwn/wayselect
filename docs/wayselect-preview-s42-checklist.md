# Wayselect preview security checklist, S42-style (TOG-5553)

Preview-only storefront at head `7ae0221`: stub listings + disabled
purchase. No live providers, no credentials, no backend writes, no
live-production activation. Verified 2026-09-27 in worktree
`TOG-5553-security-eng-wayselect-preview-security-checklist-s42-style`
(`web/server.js`, `web/preview.js`, `web/listing-detail.js`,
`web/filter.js`, `web/eligibility.js`, `web/stub-listing.js`,
`src/eligibility.js`, `src/purchase.js`, `src/sellerSubmission.js`,
`src/catalog.js`, `src/freshness.js`, `src/snapshot.js`,
`src/searchIndex.js`, `src/transport.js`, `src/validate-catalog-entry.js`,
`bin/check-preview-health`, fixtures + docs).

Prior checklist [TOG-5465](/TOG/issues/TOG-5465) covered
authz-on-endpoints / input-validation / secret-hygiene and filed
S1–S3 ([TOG-5474](/TOG/issues/TOG-5474) done,
[TOG-5475](/TOG/issues/TOG-5475) blocked,
[TOG-5476](/TOG/issues/TOG-5476) blocked,
PR #37 review [TOG-5520](/TOG/issues/TOG-5520) in_progress).
This card does the S42-style five-area pass
(auth/session, PII in flight, rate limits, fail-closed eligibility,
public exposure) and files only gaps not already tracked.

Overall: **GO for localhost stub preview, NO-GO for any public URL
exposure.** Static: 14 PASS, 1 CONDITIONAL (test env, not code),
1 new GAP (rate limiting). All other gaps already tracked — no
duplicate cards.

## 1. Auth / session handling

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| A1 | No session, cookie, token, or auth-header mechanism exists anywhere | PASS | `web/server.js:24-32` sets only `content-type`; grep `cookie\|set-cookie\|session\|localStorage\|authorization\|bearer` across `src web bin scripts` empty 2026-09-27 |
| A2 | Preview flag is the sole gate: read-only, no privilege change, off → 404 | PASS | `web/preview.js:8-14` TRUTHY set; `web/server.js:44-48,84-88` |
| A3 | Seller/buyer v1 "no auth" forward contract (anyone with flag can post/accept stub offers) | TRACKED — no new card | `docs/wayselect-seller-acceptance.md:31,129`; design [TOG-5474](/TOG/issues/TOG-5474) done, implementation under review [TOG-5520](/TOG/issues/TOG-5520) |
| A4 | No credential env, no `.env`, no key files; only `WAYSELECT_PREVIEW` + `PORT` | PASS | `web/preview.js:9`; `web/server.js:116`; `README.md:33` "No environment variables or credentials"; secret-pattern grep clean 2026-09-27 |

## 2. PII in flight

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| P1 | No real PII in repo; only stub `buyerId` `buyer-001`/`buyer-002`, no email/phone/address | PASS | `fixtures/purchase.synthetic.json`; grep `email\|phone\|address` hits only code words, no values |
| P2 | `buyerId`/free-string length caps, `providerId`/`modelId` allowlist, `provenance.source` pinning, future-`fetchedAt` reject, body cap | TRACKED — no new card | Blocked [TOG-5476](/TOG/issues/TOG-5476), under review [TOG-5520](/TOG/issues/TOG-5520) (`src/intakeLimits.js`, `web/jsonBody.js`) |
| P3 | Search query `q` reflected only through `escape-html` (CodeQL-modeled sanitizer); invalid filter values 400 with valid-value list, never ignored | PASS | `web/listing-detail.js:27-29`; `web/filter.js:40-51`; `web/server.js:56-60` |
| P4 | No request-body logging anywhere on the preview path | PASS | `web/server.js` never logs bodies; health probe logs only status lines |

## 3. Rate limits

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| R1 | No rate limiting, throttling, or 429 on the preview server | GAP → new follow-up card (this checklist, §6) | Grep `ratelimit\|rate-limit\|throttle\|limiter\|429` across `src web bin scripts docs schema` empty except an RNG constant 2026-09-27; plain `node:http` server |
| R2 | No server-boundary body cap / Content-Type gate (validators are pure functions) | TRACKED — no new card | Blocked [TOG-5476](/TOG/issues/TOG-5476) (`web/jsonBody.js` ~64KB + strict JSON under review [TOG-5520](/TOG/issues/TOG-5520)) |

Severity note for R1: low while the preview stays localhost-only stub
(single-process, three stub listings, no backend writes); becomes a
hard blocker before any public or shared preview URL.

## 4. Fail-closed eligibility

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| F1 | Unknown capability renders Unknown, never Yes; missing/false excludes from filters | PASS | `web/listing-detail.js:31-49` `capabilityRow`; `web/filter.js:65-86` |
| F2 | Malformed evaluation or evaluator throw degrades to unknown, never granted | PASS | `web/eligibility.js:159-189` `classifyEligibilityDisplay`; `web/listing-detail.js:98-119` |
| F3 | Forged `eligible:true` with non-empty reasons fails closed to unknown | PASS | TOG-5298, merged `14e5ca4` via PR #42; `web/eligibility.js:169-176` |
| F4 | Catalog-less calls no longer skip staleness silently: explicit catalog or `skipCatalogCheck:true` required | PASS | TOG-5299 `7e2d64d`, merged PR #43 (`src/eligibility.js:53-85`) |
| F5 | Stale/future catalog fails closed; non-`synthetic://` sources refused | PASS | `src/freshness.js:46-76`; `src/snapshot.js:134-141`; `src/searchIndex.js:96-102` |
| F6 | Purchase stub always refuses `403 preview_only` in every flag state; health probe guards it (H4) | PASS | `web/server.js:69-81`; `bin/check-preview-health:192-200` |
| F7 | Executable location fields (`url/endpoint/baseUrl/apiUrl`) rejected at every boundary | PASS | `src/transport.js:1-14`; `src/purchase.js:71-87`; `src/sellerSubmission.js:103-119` |

Test state: dep-free suites (`eligibility`, `freshness`, `selection`,
`support`) 24/24 PASS 2026-09-27. Suites requiring `ajv`/`escape-html`
fail in this worktree because `node_modules` is absent (no install) —
pre-existing environment gap, not a code regression. CONDITIONAL, not a
finding against the checklist.

## 5. Public exposure

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| E1 | Production server binds all interfaces by default; `PORT` unvalidated (`parseInt` NaN throws) | TRACKED — no new card | `web/server.js:116-118`; blocked [TOG-5475](/TOG/issues/TOG-5475), localhost bind under review [TOG-5520](/TOG/issues/TOG-5520); test harnesses already bind `127.0.0.1` |
| E2 | No security headers (only `content-type`; no `nosniff`, no `Referrer-Policy`; CSP would need `unsafe-inline` for inline `<style>`) | TRACKED — no new card | `web/server.js:24-32`; blocked [TOG-5475](/TOG/issues/TOG-5475) |
| E3 | Wrong-method detail routes 404 instead of 405; form action escapes HTML but does not URL-encode | TRACKED — no new card | `web/server.js:83-106`; blocked [TOG-5475](/TOG/issues/TOG-5475) |
| E4 | No secrets, no network, no cookies/sessions, snapshot hash tamper-evident | PASS | Secret sweep clean 2026-09-27; `src/transport.js:35-40` `networkUsed:false`; `src/catalog.js:207-229` hash verify |
| E5 | Overall URL exposure | **NO-GO for public URL; GO for localhost-only stub preview** under TOG-5465 A6 conditions (flag-on never public, stub data only, purchase stays 403, seller persistence requires S1) | This section |

## 6. Follow-ups filed

- NEW (this card): preview rate-limit gap R1 — filed as a child card
  (link in closing comment). All other gaps route to existing cards
  [TOG-5475](/TOG/issues/TOG-5475), [TOG-5476](/TOG/issues/TOG-5476),
  review [TOG-5520](/TOG/issues/TOG-5520); no duplicates filed.

Review date: 2026-10-04. Kill rule: replay this checklist green against
the head SHA before any preview exposure beyond localhost. No
live-production activation performed or authorized.
