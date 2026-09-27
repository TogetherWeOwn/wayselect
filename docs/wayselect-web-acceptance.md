# Wayselect web acceptance: listing-detail + search/filter (TOG-5010)

Merged product spec and executable acceptance for the Wayselect web slices
behind `WAYSELECT_PREVIEW`. Slice status:

| Slice | Card | Status |
| --- | --- | --- |
| Listing index + listing-detail page + purchase stub | TOG-4882 | Shipped, covered by `test/listing-detail.test.js` |
| Search/filter on the listing index | — (next slice) | Forward contract only (§2); script auto-skips until it lands |

Non-goals (inherited): no live provider calls, no credentials, no backend
writes, no real prices. All prices are synthetic list-price estimates; all
listings are stub data. The purchase endpoint always refuses (`403
preview_only`).

## 1. Listing-detail field contract

Data shape is catalog-entry v1 (`web/stub-listing.js`), which mirrors the
`src/catalog.js` boundary field names so the page can later bind to real
catalog data without renaming.

| # | Data field | Rendered on `GET /listings/:provider/:model` | Rule |
| --- | --- | --- | --- |
| F1 | `entry.name` | `<h1>` title and `<title>` | Must be present, HTML-escaped |
| F2 | `providerId`/`modelId` | `Listing <code>p/m</code>` line + `<title>` | Escaped; route lookup is exact match |
| F3 | `providerName` | `from …` line | Escaped |
| F4 | `attachment`, `reasoning`, `tool_call`, `structured_output` | Capabilities table, Yes/No badges (`aria-label` supported/not supported) | All four rows always render; booleans only |
| F5 | `modalities.input`, `modalities.output` | Modality rows + "Modalities covered: …" disclaimer | Comma-joined, escaped |
| F6 | `cost.input`, `cost.output` | `$X Input/Output (per 1M tokens)` rows | Non-negative numbers; synthetic-only disclaimer adjacent |
| F7 | Preview banner | `Preview build: stub data only. No purchase is processed.` | On every 200 detail and index page |
| F8 | Purchase CTA | Disabled button posting to `/listings/:p/:m/purchase` | `disabled` + `aria-disabled`; no other form target on page |
| F9 | Back link | `Back to listings` → `/listings` | Present on detail and not-found pages |

XSS rule: every dynamic value passes through the renderer's HTML escape.
Probe values (`<script>`, `<img src=x>`, quote-breakouts) must never appear
raw in detail, index, or not-found pages.

## 2. Search/filter behavior matrix (forward contract for the next slice)

The next slice extends `GET /listings` only. Detail page and purchase stub
are unchanged.

| # | Request | Expected |
| --- | --- | --- |
| S1 | `GET /listings` (no params) | 200, all stub listings in stub order |
| S2 | `?q=<text>` | 200, case-insensitive substring match against `entry.name`, route `providerId/modelId`, and `providerName` |
| S3 | `?q=` absent or blank | No text filtering (same as S1) |
| S4 | `?capability=<name>` (repeatable) | 200, keeps listings where **all** named capabilities are true. Valid names: `attachment`, `reasoning`, `tool_call`, `structured_output` |
| S5 | `?modality=<name>` (repeatable) | 200, keeps listings where the modality appears in input **or** output |
| S6 | Combined params | AND across `q` × capabilities × modalities |
| S7 | Result order | Stub order preserved (deterministic, no re-ranking) |
| S8 | Filters match nothing | 200 with empty-state copy `No listings match these filters.` plus a `Clear filters` link to `/listings` |
| S9 | Unknown `capability`/`modality` value | `400` error page naming the valid values (fail closed, never ignore) |
| S10 | Index page filter UI | A `GET` form with a `q` text input, capability checkboxes, modality checkboxes, submit, and clear link |
| S11 | Reflected `q` | Escaped in the re-rendered form value (XSS rule applies) |
| S12 | Flag off + any filter params | Same as unfiltered flag-off: 404 preview-disabled page (§4) |

## 3. Empty/error states

| # | Case | Status | Body |
| --- | --- | --- | --- |
| E1 | Unknown listing, flag on | 404 | `Listing not found` page + back link |
| E2 | Unknown path (e.g. `/nope`) | 404 | JSON `{error:"not_found"}` (any flag state) |
| E3 | `POST …/purchase` | 403 | JSON `{error:"preview_only", …}` (any flag state — stub is intentionally ungated) |
| E4 | `GET …/purchase` | 405 | JSON `{error:"method_not_allowed"}` |
| E5 | Flag off, `GET /listings` or detail | 404 | `Preview unavailable` page naming `WAYSELECT_PREVIEW` |
| E6 | Filters match nothing (next slice) | 200 | Empty-state copy + clear link (S8, not an error) |
| E7 | Unknown filter value (next slice) | 400 | Error page with valid values (S9) |

## 4. Preview-flag gating matrix

`WAYSELECT_PREVIEW` truthy values (trimmed, case-insensitive): `1`,
`true`, `yes`, `on`. Anything else, including unset, is off.

| Route | Flag on | Flag off |
| --- | --- | --- |
| `GET /listings` | 200 index | 404 preview-disabled |
| `GET /listings/:p/:m` | 200, or 404 not-found (E1) | 404 preview-disabled (even for unknown listings) |
| `POST …/purchase` | 403 (E3) | 403 (E3, ungated by design) |
| Anything else | 404 JSON (E2) | 404 JSON (E2) |

## 5. Runnable acceptance script (under 15 minutes)

```sh
node --version            # 20+
npm test                  # unit suite, ~1s
npm run accept:web        # this acceptance script, typically < 5s
```

`bin/accept-wayselect-web` (zero dependencies, stdlib only) starts the real
server on ephemeral ports and checks every row of §1, §3, and §4 against the
shipped slice. Section §2 probes run only when the search/filter slice is
present; until then they report `SKIP (search/filter slice not present)` and
the run still exits 0. Expected tail output today:

```
SUMMARY: 20 pass, 0 fail, 8 skip (search/filter slice not present) — 0.1s (budget 15m)
```

Exit code is 0 with zero failures (skips allowed), 1 otherwise. The next
slice is accepted when the same command reports zero skips.

## 6. Sign-off, metric, kill/scale

- [ ] Web Engineer: script executes end-to-end in under 15 minutes against the next slice.
- [ ] QA: pass/fail/skip semantics independently reproducible (`npm run accept:web` from a clean checkout).

Seven-day metric (by 2026-10-03): script executed green (0 fail) against one
Wayselect slice. Kill rule: if no slice lands to execute §2 against within
14 days, archive §2 instead of maintaining it. Scale rule: once executed
green, `npm run accept:web` becomes a required gate for every subsequent web
slice. Review date: 2026-10-03.

## 7. Accepted gaps

- G1: `provenance` (source/fetchedAt) exists on stub data but is not rendered.
  Accepted: the preview banner + synthetic-price disclaimer carry the
  trust message for this slice.
- G2: the purchase stub ignores the preview flag (always 403). Accepted and
  intentional: a refuse-stub has no preview-only behavior to gate.
