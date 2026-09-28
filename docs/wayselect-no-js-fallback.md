# No-JS fallback: listing-detail page (TOG-7287)

What renders with JavaScript disabled on `GET /listings/:provider/:model`
(flag on). One-paragraph version: the full listing. The shell's `<noscript>`
branch carries the same body as the `application/json` fragment, rendered
from the same builder (`listingDetailBody` in `web/listing-detail.js`), so
no-JS clients, bots, and plain-fetch probes see complete content while the
skeleton chrome and the inline fetch script stay inert.

Implementation: `web/listing-detail.js`
(`renderListingDetailShell`, `listingDetailBody`, `listingDetailFragment`);
route wiring: `web/server.js` (detail route, shell vs fragment content
negotiation). Behavior pins:
`test/listing-detail-no-js.test.js` (this contract),
`test/listing-detail-loading.test.js` (shell first paint + fragment fetch).

## What renders without JS

The `<noscript>` branch carries the full detail body — every item below is
present with JS disabled:

| # | Content | Source |
| --- | --- | --- |
| N1 | Preview banner (`Preview build: stub data only. No purchase is processed.`) | `listingDetailBody` |
| N2 | `<h1>` listing title | `entry.name` |
| N3 | `Listing <code>p/m</code> from …` route + provider line | `providerId`/`modelId`, `providerName` |
| N4 | Eligibility section (badge + headline + reason codes) | `describeEligibility` over the capability check |
| N5 | Capabilities table: Attachments, Reasoning, Tool calls, Structured output (Yes/No/Unknown badges) plus input/output modality rows | `entry.attachment`, `entry.reasoning`, `entry.tool_call`, `entry.structured_output`, `entry.modalities` |
| N6 | List-price estimate table (`$X` input/output per 1M tokens) plus the synthetic-only disclaimer and modalities-covered note | `entry.cost` |
| N7 | Disabled purchase stub: a `POST` form to `/listings/:p/:m/purchase` with a `disabled` button, plus the `403 preview_only` note (no backend writes in any path) | stub CTA |
| N8 | `Back to listings` link to `/listings` | static |

Sync guarantee: the `<noscript>` HTML is byte-identical to the
`listingDetailFragment` payload's `html`, and the legacy full render
contains the same body — one builder, three consumers, so skeleton,
no-JS, and async content can never drift apart. Every dynamic value is
HTML-escaped on the no-JS path exactly as on the fragment path.

## What requires JS (enhancement only)

Without JS the skeleton markup, the visually-hidden loading announcer, the
hidden `role="alert"` error panel with Retry, and the inline fragment-fetch
script are present but inert: no content swap, no announcement updates, no
retry. No-JS clients never need them — the content is already in
`<noscript>`. The shell chrome outside `<noscript>`/`<script>` carries no
`<form>`: the only form on the page is the disabled stub inside the
no-JS/fragment body.

## Boundaries

| Case | No-JS response |
| --- | --- |
| Flag off (`WAYSELECT_PREVIEW` unset), plain GET | `404` Preview-unavailable page naming `WAYSELECT_PREVIEW`; no listing `<noscript>` |
| Flag off, `Accept: application/json` | `404` `{error: "preview_disabled"}` (the shell renders its alert panel) |
| Unknown listing, flag on, plain GET | `404` Listing-not-found page with the search hint + index link |
| Unknown listing, flag on, `Accept: application/json` | `404` `{error: "listing_not_found"}` |
| Shell vs fragment | Selected by `Accept` (`application/json` → fragment); every variant carries `Vary: Accept` |

## How to verify

```sh
WAYSELECT_PREVIEW=1 node web/server.js &
curl -s http://127.0.0.1:3000/listings/northstar/alpha-chat | grep -o '<noscript>.*' | head -c 200
curl -s -H 'Accept: application/json' http://127.0.0.1:3000/listings/northstar/alpha-chat | head -c 200
node --test --import ./support/no-network-guard.js test/listing-detail-no-js.test.js
```

The plain-GET body must contain `<noscript>` with the N1–N8 content; the
fragment's `html` must be byte-identical to it. With JS disabled in a
browser (DevTools → disable JavaScript, or `curl` as above), the listing
title, capabilities, prices, eligibility, and disabled purchase stub all
remain readable.
