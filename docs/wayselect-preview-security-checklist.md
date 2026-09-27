# Wayselect preview security checklist (TOG-5465)

Preview-only storefront: stub listings + disabled purchase. No live providers,
no credentials, no backend writes. Verified against head tree 2026-09-27
(`web/server.js`, `web/listing-detail.js`, `web/preview.js`,
`web/eligibility.js`, `src/sellerSubmission.js`, `src/purchase.js`,
`src/transport.js`, `src/catalog.js`, `docs/wayselect-seller-acceptance.md`).

## 1. Authorization on seller/storefront endpoints

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| A1 | Preview-gated reads: `GET /listings` + detail 404 when flag off | PASS | `web/server.js:42-49,66-70`; `web/preview.js:8-14` |
| A2 | Purchase default-deny: `POST …/purchase` 403 `preview_only` in every flag state | PASS | `web/server.js:51-63` |
| A3 | No seller offer/accept routes exist yet (forward contract only) — nothing to bypass | PASS | `web/server.js:9-20`; seller acceptance §2–§3 unimplemented, script skips |
| A4 | Seller v1 forward contract specifies **no auth** ("anyone with the preview flag can post/accept stub offers") | GAP → slice S1 | `docs/wayselect-seller-acceptance.md:31,129-130` (G2) |
| A5 | Preview server binds all interfaces by default; `PORT` unvalidated (`parseInt` NaN throws) | GAP → slice S2 | `web/server.js:94-106` |
| A6 | No authn/authz beyond preview flag | ACCEPTED for stub-only preview with conditions below | — |

Conditions for A6 (must hold until S1 lands): preview with flag on never
exposed publicly; bind localhost; stub data only; purchase stays 403; any
persistent/monetized seller slice requires S1 first.

## 2. Input validation

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| V1 | All dynamic HTML escaped (`escapeHtml` on every interpolation incl. 404 path) | PASS | `web/listing-detail.js:20-27,137-209` |
| V2 | Unknown capabilities render `Unknown`, never Yes | PASS | `capabilityRow`, `costCell`, `modalityList` |
| V3 | Eligibility unknown fail-closed (malformed evaluation / eval throw → unknown) | PASS | `web/eligibility.js:112-140`; `web/listing-detail.js:96-117` |
| V4 | Seller/purchase validators: exact keys, `unknown-field` reject, forbidden `url/endpoint/baseUrl/apiUrl` at any depth, `confirm===true`, `modelId===entry.id` | PASS | `src/sellerSubmission.js:95-119,342-378`; `src/purchase.js:63-87,97-113` |
| V5 | Provenance required; every rejection names key + source | PASS | `sellerSubmission.js:346-349`; `purchase.js:158-160` |
| V6 | Path params: URL-parse try/catch, `decodeURIComponent` try/catch, exact stub lookup, no filesystem access | PASS | `web/server.js:34-40,71-85` |
| V7 | No length caps on free strings (provider/model/name/description/buyer/source/etag) | GAP → slice S3 | `requireNonEmptyString` in both validators; offer contract caps buyer at 120 but `purchase.js` does not |
| V8 | No character allowlist for `providerId`/`modelId` (slash, traversal, controls pass validation) | GAP → slice S3 | `sellerSubmission.js:358-364`; `purchase.js:170-177` |
| V9 | `provenance.source` accepts any non-empty string; `fetchedAt` accepts future dates | GAP → slice S3 | `sellerSubmission.js:303-340`; contrast snapshot boundary refusing non-`synthetic://` |
| V10 | No body-size cap / Content-Type enforcement (validators are pure; future POST routes must cap ~64KB and 400 on malformed JSON per O8) | GAP → slice S3 | Forward contract §2 O8; no `Content-Length` handling in `web/server.js` |
| V11 | Hardening nits: non-GET to detail returns 404 (not 405); form action HTML-escapes but does not URL-encode; no security headers (`X-Content-Type-Options`, `Referrer-Policy`; CSP needs `unsafe-inline` due to inline `<style>`) | GAP → slice S2 | `web/server.js:65-88`; `listing-detail.js:49-84,169-171` |

## 3. Secret hygiene

| # | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| S1 | No secrets in repo (grep `SECRET|TOKEN|KEY|password|credential|api_key` → only code identifiers + `WAYSELECT_PREVIEW` docs) | PASS | Repo-wide grep 2026-09-27; `README.md:33` "No environment variables or credentials" |
| S2 | Only runtime env is `WAYSELECT_PREVIEW` (flag) + `PORT`; no credential env, no `.env`, no key files | PASS | `web/preview.js:9`; `web/server.js:98` |
| S3 | No network: `FakeTransport` `networkUsed:false`; executable location fields rejected at every boundary | PASS | `src/transport.js:1-27`; `src/catalog.js`; `src/sellerSubmission.js:103-119` |
| S4 | No cookies, auth headers, sessions, or body logging | PASS | `web/server.js:22-30` (only `content-type` set) |
| S5 | Catalog snapshot hash verified (`sha256:` + recompute, tamper refuses) | PASS | `src/catalog.js:105-227` |
| S6 | Standing rule: never log request bodies, never add secrets for preview | ONGOING | — |

## 4. Gaps filed as slices

- **S1 — Seller auth before anything persistent/monetized.** Design preview seller identity (even a stub token) for the offers/accept slice; retire the "no auth in v1" acceptance (G2) before any write persists or money moves. Owner: seller slice engineer.
- **S2 — Preview serving hardening.** Bind localhost by default, validate `PORT`, return 405 on wrong method for detail routes, URL-encode path segments in rendered form actions, add `X-Content-Type-Options: nosniff` + `Referrer-Policy`. Owner: web engineer.
- **S3 — Intake hardening for future POST routes.** Length caps (e.g. provider/model ≤64, buyer ≤120, description ≤4k, etag ≤256), `providerId`/`modelId` allowlist (`[a-z0-9][a-z0-9-]{0,63}`), `provenance.source` must be `synthetic://…`, reject future `fetchedAt`, request body cap (~64KB) + strict `Content-Type: application/json` + 400 on malformed JSON. Owner: seller slice engineer.

## 5. Seven-day metric

Accepted checklist = this document posted as work product + S1–S3 filed.
Review date: 2026-10-04. Kill rule: if no seller POST slice lands within 14
days, S1/S3 stay parked; replay this checklist green against the head SHA
before any preview exposure beyond localhost.
