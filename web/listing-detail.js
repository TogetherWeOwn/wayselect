// Listing-detail page renderer for the Wayselect web slice (TOG-4882) with
// per-model eligibility display (TOG-5221) and a shell-first loading state
// (TOG-5499).
//
// Pure functions: listing in, HTML string out. All dynamic values are
// HTML-escaped. The purchase CTA is a stub — a disabled form that posts to a
// route which refuses with 403. No backend writes anywhere on this page.
//
// Loading model: `renderListingDetailShell` returns the first paint — a
// skeleton behind `aria-busy` plus a `<noscript>` full render and an inline
// script that fetches the `application/json` fragment (`listingDetailFragment`)
// and swaps it in. Slow networks show skeleton then content; failed fetches
// show the `role="alert"` error panel with retry. No-JS clients, bots, and the
// acceptance probes read the `<noscript>` full render.
//
// Eligibility is a read-only display over existing capability-check output
// (web/eligibility.js consuming src/eligibility.js): granted / blocked /
// unknown badges with fail-closed copy on unknown. Rendering never throws:
// an evaluation failure degrades to unknown.

import escapeHtmlLib from "escape-html";
import {
  ELIGIBILITY_STATE,
  describeEligibility,
  evaluateListingEligibility,
  evaluateListingsEligibility,
} from "./eligibility.js";
import {
  LISTINGS_DEFAULT_LIMIT,
  LISTINGS_DEFAULT_OFFSET,
  LISTINGS_DEFAULT_SORT,
  LISTINGS_MAX_LIMIT,
  LISTINGS_MAX_QUERY_LENGTH,
  VALID_CAPABILITIES,
  VALID_LISTING_SORTS,
  VALID_MODALITIES,
  emptyFilters,
} from "./filter.js";

// HTML escaping delegates to the `escape-html` library (`&<>"'` entity
// encoding, output-identical to the previous hand-rolled version). The
// library form matters: CodeQL's js/reflected-xss query models it as a
// sanitizer, while a custom replaceAll chain is flagged (PR #33 CodeQL).
// Wrapper keeps existing call sites unchanged and coerces to string.
function escapeHtml(value) {
  return escapeHtmlLib(String(value));
}

function capabilityRow(label, value) {
  // Fail closed: a missing (non-boolean) capability value renders as Unknown,
  // never as Yes and never silently as No.
  if (typeof value !== "boolean") {
    return `<tr><th scope="row">${escapeHtml(label)}</th><td><span class="badge badge-unknown" aria-label="capability unknown">Unknown</span></td></tr>`;
  }
  const badge = value
    ? '<span class="badge badge-on" aria-label="supported">Yes</span>'
    : '<span class="badge badge-off" aria-label="not supported">No</span>';
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${badge}</td></tr>`;
}

function modalityList(modalities, key) {
  const values = modalities?.[key];
  if (!Array.isArray(values)) {
    return "unknown";
  }
  return values.join(", ");
}

// TOG-6049: nonce attribute for the inline <style>/<script> tags. The
// server passes a fresh base64 nonce per response; renderers called without
// one (unit tests, acceptance probes) emit the legacy bare tag. The value
// is HTML-escaped so a caller-supplied string can never break out of the
// attribute (base64 itself needs no escaping — defense in depth).
function nonceAttr(cspNonce) {
  return cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : "";
}

function layout({ title, body, cspNonce, canonical }) {
  const canonicalTag =
    typeof canonical === "string" && canonical !== ""
      ? `\n<link rel="canonical" href="${escapeHtml(canonical)}">`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${canonicalTag}
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Wayselect</title>
<style${nonceAttr(cspNonce)}>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; line-height: 1.5; }
main { max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
.preview-banner { border: 1px dashed currentColor; border-radius: 0.5rem; padding: 0.5rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #888; padding: 0.5rem 0.75rem; text-align: left; }
.badge { display: inline-block; border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.85rem; }
.badge-on { background: #d3f9d8; color: #1a4d1f; }
.badge-off { background: #f1f3f5; color: #495057; }
.badge-granted { background: #d3f9d8; color: #1a4d1f; }
.badge-blocked { background: #ffe3e3; color: #7a1f1f; }
.badge-unknown { background: #fff3bf; color: #5c4a00; }
.eligibility { margin-top: 1.5rem; padding: 1rem; border: 1px solid #888; border-radius: 0.5rem; }
.eligibility ul { margin-bottom: 0; }
.cta { margin-top: 1.5rem; padding: 1rem; border: 1px solid #888; border-radius: 0.5rem; }
.cta button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: not-allowed; }
.cta p { font-size: 0.9rem; margin-bottom: 0; }
.back { display: inline-block; margin-top: 2rem; }
.site-header { max-width: 44rem; margin: 0 auto; padding: 1rem 1rem 0; }
.site-header nav { display: flex; align-items: baseline; gap: 0.75rem; }
.site-title { font-weight: 700; }
.site-tag { font-size: 0.8rem; border: 1px solid currentColor; border-radius: 999px; padding: 0 0.6rem; }
.site-footer { max-width: 44rem; margin: 0 auto; padding: 0 1rem 2rem; font-size: 0.85rem; opacity: 0.85; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 0.75rem; top: -4rem; z-index: 10; background: #fff; color: #000; padding: 0.5rem 1rem; border-radius: 0.375rem; transition: top 0.15s ease-in-out; }
.skip-link:focus-visible { top: 0.75rem; }
main:focus { outline: none; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; border-radius: 0.25rem; }
@media (forced-colors: active) { a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid Highlight; } select:focus-visible { outline: 3px solid Highlight; } }
@media (forced-colors: active) { .badge { border: 1px solid CanvasText; } }
.skeleton { border-radius: 0.375rem; background: linear-gradient(90deg, rgba(128, 128, 128, 0.28) 25%, rgba(128, 128, 128, 0.12) 50%, rgba(128, 128, 128, 0.28) 75%); background-size: 200% 100%; animation: skeleton-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } .skip-link { transition: none; } }
@keyframes skeleton-pulse { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.skeleton-title { height: 2rem; width: 60%; margin: 0.75rem 0 1rem; }
.skeleton-line { height: 1rem; margin: 0.5rem 0; }
.skeleton-line.short { width: 45%; }
.skeleton-block { height: 5.5rem; margin: 0.75rem 0; }
.skeleton-cta { height: 3.5rem; margin-top: 1.5rem; }
.loading-note { font-size: 0.9rem; }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<header class="site-header"><nav aria-label="Primary"><span class="site-title">Wayselect</span> <span class="site-tag">Preview</span></nav></header>
<main id="main-content" tabindex="-1">
${body}
</main>
<footer class="site-footer"><p>Preview build: stub data only. No purchase is processed.</p></footer>
</body>
</html>
`;
}

function eligibilityBadge(described) {
  const badgeClass =
    described.state === ELIGIBILITY_STATE.GRANTED
      ? "badge-granted"
      : described.state === ELIGIBILITY_STATE.BLOCKED
        ? "badge-blocked"
        : "badge-unknown";
  return `<span class="badge ${badgeClass}" aria-label="eligibility: ${escapeHtml(described.state)}">${escapeHtml(described.label)}</span>`;
}

function resolveDetailEvaluation(listing, override) {
  if (override !== undefined) {
    return override;
  }
  try {
    return evaluateListingEligibility(listing);
  } catch {
    // Fail closed: an evaluation failure renders as unknown, never as granted.
    return null;
  }
}

function resolveIndexEvaluations(listings, overrides) {
  if (overrides instanceof Map) {
    return overrides;
  }
  try {
    return evaluateListingsEligibility(listings);
  } catch {
    return new Map();
  }
}

function eligibilitySection(listing, override) {
  const evaluation = resolveDetailEvaluation(listing, override);
  const described = describeEligibility(evaluation);
  const reasons =
    described.reasons.length > 0
      ? `<ul>${described.reasons.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("")}</ul>`
      : "";
  return `<section class="eligibility" aria-label="Eligibility">
<h2>Eligibility</h2>
<p>${eligibilityBadge(described)} ${escapeHtml(described.headline)}</p>
${reasons}</section>`;
}

// Buyer trust signals (TOG-8061, spec docs/wayselect-buyer-trust-signals.md
// §2–§3): display-only stub ratings, preview-honest guarantee copy, and the
// dispute entry point. Copy is pinned in the spec — no word changes without
// a Code Reviewer pass on that doc. Every dynamic value is HTML-escaped
// (the web-spec XSS rule binds T1–T4).
//
// Fail-closed rating validation: `average` must be a finite number in 0–5
// inclusive, `sales` an integer ≥ 0; anything else renders the unrated copy
// and the page still 200s — never a default score, never stars without a
// count.
function validRating(rating) {
  if (rating === null || typeof rating !== "object" || Array.isArray(rating)) {
    return null;
  }
  const { average, sales } = rating;
  if (typeof average !== "number" || !Number.isFinite(average) || average < 0 || average > 5) {
    return null;
  }
  if (!Number.isInteger(sales) || sales < 0) {
    return null;
  }
  return { average, sales };
}

// T1 rating line for the index (`★ {avg} · {n} sales`, `{avg}` one decimal)
// or the unrated copy. Renders after the eligibility badge, never before it,
// and never re-ranks index order.
function ratingLine(rating) {
  const valid = validRating(rating);
  if (!valid) {
    return "No ratings yet";
  }
  return `★ ${valid.average.toFixed(1)} · ${valid.sales} sales`;
}

// T2 seller-rating section: aggregate line + stub disclaimer, or the
// unrated body verbatim.
function ratingSection(listing) {
  const valid = validRating(listing.rating);
  const body = valid
    ? `<p>★ ${escapeHtml(valid.average.toFixed(1))} from ${escapeHtml(valid.sales)} stub sales. Stub ratings: synthetic sales history for preview only. Not real buyers.</p>`
    : `<p>No ratings yet. This listing has no stub sales history — nothing is hidden, there is just nothing to show.</p>`;
  return `<section aria-label="Seller rating">
<h2>Seller rating</h2>
${body}</section>`;
}

// T3 purchase-guarantee section: pinned preview-honest copy — disabled
// purchases first, the launch-intent `full refund` only when buying opens.
function guaranteeSection() {
  return `<section aria-label="Purchase guarantee">
<h2>Purchase guarantee</h2>
<p>Preview build: purchases are disabled, so you can never be charged here. When buying opens, every purchase is covered — if a listing is materially not as described, report it and get a full refund.</p></section>`;
}

// T4 dispute entry point: entry copy plus a link to the §6 disputes route.
// A link, not a form: docs/wayselect-web-acceptance.md F8 pins exactly one
// `<form>` (the purchase stub) on detail pages, so a second form would fail
// the web and checkout acceptance scripts.
function reportSection(listing) {
  const href = `/listings/${encodeURIComponent(listing.providerId)}/${encodeURIComponent(listing.modelId)}/disputes`;
  return `<section aria-label="Report a problem">
<h2>Report a problem</h2>
<p>Something wrong with this listing? File a stub report — nothing leaves this preview, and filing never charges or refunds anything.</p>
<p><a href="${escapeHtml(href)}">Report a problem (stub)</a></p></section>`;
}

function costCell(cost, key) {
  const value = cost?.[key];
  return typeof value === "number" && Number.isFinite(value) ? `$${escapeHtml(value)}` : "unknown";
}

function listingDetailTitle(listing) {
  const { entry } = listing;
  return `${entry.name} (${listing.providerId}/${listing.modelId})`;
}

function listingDetailBody(listing, evaluationOverride) {
  const { entry } = listing;
  const inputModalities = Array.isArray(entry.modalities?.input) ? entry.modalities.input : [];
  const outputModalities = Array.isArray(entry.modalities?.output) ? entry.modalities.output : [];
  const modalities = [...inputModalities, ...outputModalities].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  // T2–T4 (TOG-8061): fixed order Eligibility → Seller rating → Purchase
  // guarantee → Report a problem → Capabilities. One builder feeds the shell,
  // the `<noscript>` branch, and the JSON fragment, so shell/noscript/async
  // can never drift (T5).
  return `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
<h1>${escapeHtml(entry.name)}</h1>
<p>Listing <code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code> from ${escapeHtml(listing.providerName)}.</p>
${eligibilitySection(listing, evaluationOverride)}
${ratingSection(listing)}
${guaranteeSection()}
${reportSection(listing)}
<h2>Capabilities</h2>
<table>
<tbody>
${capabilityRow("Attachments", entry.attachment)}
${capabilityRow("Reasoning", entry.reasoning)}
${capabilityRow("Tool calls", entry.tool_call)}
${capabilityRow("Structured output", entry.structured_output)}
<tr><th scope="row">Input modalities</th><td>${escapeHtml(modalityList(entry.modalities, "input"))}</td></tr>
<tr><th scope="row">Output modalities</th><td>${escapeHtml(modalityList(entry.modalities, "output"))}</td></tr>
</tbody>
</table>
<h2>List-price estimate</h2>
<table>
<tbody>
<tr><th scope="row">Input (per 1M tokens)</th><td>${costCell(entry.cost, "input")}</td></tr>
<tr><th scope="row">Output (per 1M tokens)</th><td>${costCell(entry.cost, "output")}</td></tr>
</tbody>
</table>
<p><small>Synthetic list-price estimates only; not actual cost or savings. Modalities covered: ${escapeHtml(modalities.join(", "))}.</small></p>
<div class="cta">
<form method="post" action="/listings/${escapeHtml(encodeURIComponent(listing.providerId))}/${escapeHtml(encodeURIComponent(listing.modelId))}/purchase">
<button type="submit" disabled aria-disabled="true" title="Disabled in preview">Purchase (stub — disabled in preview)</button>
</form>
<p>No backend writes: the purchase endpoint refuses with <code>403 preview_only</code> while the flag gates this page.</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;
}

// First paint (TOG-5499): the skeleton shell. `aria-busy` marks the loading
// region while the inline script fetches the fragment; the `<noscript>`
// branch carries the same full render so no-JS clients, bots, and the
// plain-fetch acceptance probes see complete content. The error panel is
// hidden until a fetch fails, and Retry re-runs the same fragment request.
export function renderListingDetailShell(listing, evaluationOverride, options) {
  const { entry } = listing;
  const title = listingDetailTitle(listing);
  const routePath = `/listings/${encodeURIComponent(listing.providerId)}/${encodeURIComponent(listing.modelId)}`;
  const cspNonce = typeof options?.cspNonce === "string" ? options.cspNonce : undefined;
  const noscriptBody = listingDetailBody(listing, evaluationOverride);
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
<p id="listing-detail-status" class="visually-hidden" role="status">Loading listing details…</p>
<div id="listing-detail" aria-busy="true">
<p class="loading-note" aria-hidden="true">Loading listing details…</p>
<div class="skeleton skeleton-title" aria-hidden="true"></div>
<div class="skeleton skeleton-line" aria-hidden="true"></div>
<div class="skeleton skeleton-line short" aria-hidden="true"></div>
<div class="skeleton skeleton-block" aria-hidden="true"></div>
<div class="skeleton skeleton-block" aria-hidden="true"></div>
<div class="skeleton skeleton-cta" aria-hidden="true"></div>
<div id="listing-detail-error" role="alert" hidden>
<p>Couldn&rsquo;t load listing details. Check your connection and retry.</p>
<button type="button" id="listing-detail-retry">Retry</button>
</div>
</div>
<noscript>${noscriptBody}</noscript>
<script${nonceAttr(cspNonce)}>
(function () {
  var mount = document.getElementById("listing-detail");
  var status = document.getElementById("listing-detail-status");
  var errorPanel = document.getElementById("listing-detail-error");
  var retryButton = document.getElementById("listing-detail-retry");
  function announce(message) {
    if (status) {
      status.textContent = message;
    }
  }
  function load() {
    if (errorPanel) {
      errorPanel.hidden = true;
    }
    announce("Loading listing details…");
    fetch(${JSON.stringify(routePath)}, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) {
          throw new Error("listing fragment " + res.status);
        }
        return res.json();
      })
      .then(function (payload) {
        if (!payload || typeof payload.html !== "string") {
          throw new Error("listing fragment malformed");
        }
        mount.setAttribute("aria-busy", "false");
        var content = document.createElement("template");
        content.innerHTML = payload.html;
        mount.replaceChildren(content.content.cloneNode(true));
        announce("Listing details loaded.");
      })
      .catch(function () {
        mount.setAttribute("aria-busy", "false");
        announce("Couldn’t load listing details. Check your connection and retry.");
        if (errorPanel) {
          errorPanel.hidden = false;
          var retry = document.getElementById("listing-detail-retry");
          if (retry) {
            retry.focus();
          }
        }
      });
  }
  if (retryButton) {
    retryButton.addEventListener("click", load);
  }
  load();
})();
</script>`;

  // TOG-6044: trailing-slash variants serve the same body, so the shell
  // pins the slashless route path as canonical (SEO/duplicate-cache).
  return layout({ title, body, cspNonce, canonical: routePath });
}

// JSON fragment payload behind the shell: the full detail body as `html`,
// rendered from the same builder as the `<noscript>` branch so skeleton,
// noscript, and async content can never drift apart. Same route path —
export function listingDetailFragment(listing, evaluationOverride) {
  return { html: listingDetailBody(listing, evaluationOverride) };
}

// TOG-6049: page renderers accept an optional trailing `{ cspNonce }` so
// the server can stamp the request nonce on the inline <style>/<script>
// tags. Omitted → legacy bare tags (unit tests, acceptance probes).
function pageNonce(options) {
  return typeof options?.cspNonce === "string" ? options.cspNonce : undefined;
}

export function renderListingDetail(listing, evaluationOverride, options) {
  // TOG-6044: same canonical as the shell — the slashless detail path.
  const canonical = `/listings/${encodeURIComponent(listing.providerId)}/${encodeURIComponent(listing.modelId)}`;
  return layout({
    title: listingDetailTitle(listing),
    body: listingDetailBody(listing, evaluationOverride),
    cspNonce: pageNonce(options),
    canonical,
  });
}

export function renderListingDetailError(providerId, modelId, options) {
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
<div role="alert">
<h1>Couldn&rsquo;t load listing details</h1>
<p>No stub listing data could be loaded for <code>${escapeHtml(providerId)}/${escapeHtml(modelId)}</code>. Please retry.</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Listing unavailable", body, cspNonce: pageNonce(options) });
}

export function renderNotFound(providerId, modelId, options) {
  // TOG-5752: designed miss page — the miss is named, then a search hint
  // (the requested model id prefilled as the index `q`) plus the index
  // link. The hint query is capped at the index `q` bound so the link
  // never 400s; ids are URL-encoded inside the HTML escape (S2 pattern).
  const hintQuery = String(modelId).slice(0, LISTINGS_MAX_QUERY_LENGTH);
  const body = `<h1>Listing not found</h1>
<p>No stub listing matches <code>${escapeHtml(providerId)}/${escapeHtml(modelId)}</code>.</p>
<p>Try <a href="/listings?q=${escapeHtml(encodeURIComponent(hintQuery))}">searching the listings</a> for a similar name, or browse the full <a href="/listings">listing index</a>.</p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Not found", body, cspNonce: pageNonce(options) });
}

// TOG-5714: HTML 404 page for unknown (non-listing) paths, served only when
// the client explicitly negotiates `Accept: text/html` (e.g. a browser
// address-bar navigation). API-shaped callers get the JSON `{error:
// "not_found"}` payload instead — see the 404 content-type contract in
// web/server.js. Accepts the same optional `{ cspNonce }` as the other page
// renderers (TOG-6049).
export function renderRouteNotFound(path, options) {
  const body = `<h1>Page not found</h1>
<p>No preview page matches <code>${escapeHtml(path)}</code>.</p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Not found", body, cspNonce: pageNonce(options) });
}

export function renderPreviewDisabled(options) {
  const body = `<h1>Preview unavailable</h1>
<p>This page is behind the <code>WAYSELECT_PREVIEW</code> flag, which is currently off.</p>`;
  return layout({ title: "Preview unavailable", body, cspNonce: pageNonce(options) });
}

const CAPABILITY_LABELS = Object.freeze({
  attachment: "Attachments",
  reasoning: "Reasoning",
  tool_call: "Tool calls",
  structured_output: "Structured output",
});

function checkboxRow(name, values, selected) {
  return values
    .map((value) => {
      const label = name === "capability" ? (CAPABILITY_LABELS[value] ?? value) : value;
      const checked = selected.includes(value) ? " checked" : "";
      // TOG-6038: explicit id/for pairing on top of the wrapping label so
      // every checkbox has a programmatically associated label that both AT
      // and tests can resolve. Ids derive from the enum-controlled value.
      const id = `filter-${name}-${value}`;
      return `<label for="${escapeHtml(id)}"><input type="checkbox" id="${escapeHtml(id)}" name="${name}" value="${escapeHtml(value)}"${checked}> ${escapeHtml(label)}</label>`;
    })
    .join("\n");
}

// Human-readable labels for the explicit result ordering (TOG-6362, gap
// G1). Keys are the `VALID_LISTING_SORTS` values; the order here is the
// dropdown order.
const SORT_LABELS = Object.freeze({
  default: "Stub order",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  "name-asc": "Name: A to Z",
  "route-asc": "Route ID: A to Z",
});

function sortOptions(selected) {
  const active =
    typeof selected === "string" && VALID_LISTING_SORTS.includes(selected)
      ? selected
      : LISTINGS_DEFAULT_SORT;
  return VALID_LISTING_SORTS.map(
    (value) =>
      `<option value="${escapeHtml(value)}"${value === active ? " selected" : ""}>${escapeHtml(SORT_LABELS[value] ?? value)}</option>`,
  ).join("\n");
}

// Sticky filter inputs (TOG-6733, gap R4-27): the form echoes the submitted
// `limit`/`offset` alongside `q`/facets/sort so re-submitting the form keeps
// the current page window instead of silently resetting to 20/0. Values come
// from the server-sliced `pageInfo` (validated integers upstream), escaped
// like every other reflected value.
function filterForm(filters, pageInfo) {
  const active = filters ?? emptyFilters();
  const q = typeof active.q === "string" ? active.q : "";
  const capabilities = Array.isArray(active.capabilities) ? active.capabilities : [];
  const modalities = Array.isArray(active.modalities) ? active.modalities : [];
  const limit =
    Number.isSafeInteger(pageInfo?.limit) && pageInfo.limit > 0
      ? pageInfo.limit
      : LISTINGS_DEFAULT_LIMIT;
  const offset =
    Number.isSafeInteger(pageInfo?.offset) && pageInfo.offset >= 0
      ? pageInfo.offset
      : LISTINGS_DEFAULT_OFFSET;
  // TOG-6392: the form lives in a labelled section with a visible h2 so
  // the index keeps an unbroken h1 -> h2 hierarchy like the detail page
  // (h1 + h2 Eligibility/Capabilities/List-price). The section name mirrors
  // the form's accessible name so SR users hear one consistent label.
  return `<section aria-labelledby="filter-heading">
<h2 id="filter-heading">Filter listings</h2>
<form method="get" action="/listings" role="search" aria-label="Filter listings">
<label for="filter-q">Search <input type="text" id="filter-q" name="q" value="${escapeHtml(q)}" maxlength="${LISTINGS_MAX_QUERY_LENGTH}"></label>
<label for="filter-limit">Results per page <input type="number" id="filter-limit" name="limit" value="${escapeHtml(limit)}" min="1" max="${LISTINGS_MAX_LIMIT}"></label>
<label for="filter-offset">Skip results <input type="number" id="filter-offset" name="offset" value="${escapeHtml(offset)}" min="0"></label>
<fieldset><legend>Capabilities</legend>
${checkboxRow("capability", VALID_CAPABILITIES, capabilities)}
</fieldset>
<fieldset><legend>Modalities</legend>
${checkboxRow("modality", VALID_MODALITIES, modalities)}
</fieldset>
<label for="filter-sort">Sort by <select id="filter-sort" name="sort">
${sortOptions(active.sort)}
</select></label>
<button type="submit">Apply filters</button>
<a href="/listings">Clear filters</a>
</form>
</section>`;
}

function invalidFilterLine({ kind, value, valid }) {
  return `Unknown ${escapeHtml(kind)} &quot;${escapeHtml(value)}&quot;. Valid values: ${valid.map(escapeHtml).join(", ")}.`;
}

// TOG-6374 (Gap A4): the 400 page presents every error, not just the
// first. A single error keeps the legacy paragraph copy byte-identical
// (spec-pinned in docs/wayselect-onboarding-spec.md); two or more render
// as a list so no problem is hidden. `errors` is optional — callers with
// the legacy `{ kind, value, valid }` shape still render.
export function renderInvalidFilter({ kind, value, valid, errors }, options) {
  const list = Array.isArray(errors) && errors.length > 0 ? errors : [{ kind, value, valid }];
  const detail =
    list.length === 1
      ? `<p>${invalidFilterLine(list[0])}</p>`
      : `<p>${list.length} invalid filters:</p>\n<ul>\n${list.map((entry) => `<li>${invalidFilterLine(entry)}</li>`).join("\n")}\n</ul>`;
  const body = `<h1>Invalid filter</h1>
${detail}
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Invalid filter", body, cspNonce: pageNonce(options) });
}

// Paged navigation for the listing index (TOG-6028). `pageInfo` is the
// `{ total, limit, offset }` window the server sliced; without it the full
// array renders with the legacy "N listings found." copy. Prev/Next links
// preserve the active filters (and the explicit sort, TOG-6362) so paging
// never drops a filter or silently reverts to stub order.
function pageHref(filters, limit, offset) {
  const params = new URLSearchParams();
  if (typeof filters?.q === "string" && filters.q !== "") {
    params.set("q", filters.q);
  }
  for (const name of filters?.capabilities ?? []) {
    params.append("capability", name);
  }
  for (const name of filters?.modalities ?? []) {
    params.append("modality", name);
  }
  // Default sort stays unpinned so legacy links keep their exact shape;
  // only an explicit non-default sort rides along.
  if (typeof filters?.sort === "string" && filters.sort !== LISTINGS_DEFAULT_SORT) {
    params.set("sort", filters.sort);
  }
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  const qs = params.toString();
  return `/listings${qs ? `?${qs}` : ""}`;
}

// TOG-7275: numbered page links with aria-current on the current page,
// bounded to a small window (current ±2 plus first/last) so large catalogs
// never render hundreds of links.
function pageNumberLinks(filters, limit, currentPage, totalPages) {
  const pages = new Set([1, totalPages]);
  for (let p = currentPage - 2; p <= currentPage + 2; p += 1) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const parts = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) parts.push(`<span aria-hidden="true">&hellip;</span>`);
    const href = escapeHtml(pageHref(filters, limit, (p - 1) * limit));
    parts.push(
      p === currentPage
        ? `<a href="${href}" aria-current="page">${p}</a>`
        : `<a href="${href}">${p}</a>`,
    );
    prev = p;
  }
  return parts.join(" ");
}

function pageNav(filters, total, limit, offset, shown) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(totalPages, Math.floor(offset / limit) + 1);
  const links = [];
  if (offset > 0) {
    links.push(
      `<a href="${escapeHtml(pageHref(filters, limit, Math.max(0, offset - limit)))}" rel="prev">Previous</a>`,
    );
  }
  if (totalPages > 1) {
    links.push(pageNumberLinks(filters, limit, currentPage, totalPages));
  }
  if (offset + shown < total) {
    links.push(
      `<a href="${escapeHtml(pageHref(filters, limit, offset + limit))}" rel="next">Next</a>`,
    );
  }
  return links.length === 0 ? "" : `<nav aria-label="Listings pages"><p>${links.join(" ")}</p></nav>`;
}

export function renderListingIndex(listings, evaluationsOverride, filters, pageInfo, options) {
  const evaluations = resolveIndexEvaluations(listings, evaluationsOverride);
  const active = filters ?? emptyFilters();
  const total =
    Number.isSafeInteger(pageInfo?.total) && pageInfo.total >= 0 ? pageInfo.total : listings.length;
  const limit =
    Number.isSafeInteger(pageInfo?.limit) && pageInfo.limit > 0 ? pageInfo.limit : listings.length;
  const offset =
    Number.isSafeInteger(pageInfo?.offset) && pageInfo.offset >= 0 ? pageInfo.offset : 0;
  const windowed = total !== listings.length || offset > 0;
  const countCopy = total === 1 ? "1 listing" : `${total} listings`;
  let results;
  // TOG-6392: every results branch carries a visible h2 Results heading
  // (labelledby, not aria-label) so the index keeps an unbroken h1 -> h2
  // hierarchy on populated, empty, and past-the-end renders alike. The
  // accessible name stays "Results" so existing SR announcements match.
  const resultsOpen = `<section aria-labelledby="results-heading">\n<h2 id="results-heading">Results</h2>`;
  if (listings.length === 0) {
    // Offset past the end is a valid empty page, not a filter miss: say so
    // and link back to the first page instead of blaming the filters.
    results =
      total > 0
        ? `${resultsOpen}\n<p role="status" aria-live="polite">${escapeHtml(countCopy)} found. No listings on this page.</p>\n<a href="${escapeHtml(pageHref(active, limit, 0))}">Back to first page</a>\n</section>`
        : `${resultsOpen}\n<p role="status" aria-live="polite">No listings match these filters.</p>\n<a href="/listings">Clear filters</a>\n</section>`;
  } else {
    const status =
      `${countCopy} found.` + (windowed ? ` Showing ${offset + 1}-${offset + listings.length}.` : "");
    results =
      `${resultsOpen}\n<p role="status" aria-live="polite">${escapeHtml(status)}</p>\n<ul>\n${listings
        .map((listing) => {
          const described = describeEligibility(
            evaluations.get(`${listing.providerId}/${listing.modelId}`) ?? null,
          );
          // S2 (TOG-5475, preserved through the main rebase): path
          // segments are URL-encoded inside the HTML escape so ids with
          // reserved characters keep working hrefs without XSS.
          // T1 (TOG-8061): the rating line follows the eligibility badge so
          // it can never move before or override the badge state.
          return `<li><a href="/listings/${escapeHtml(encodeURIComponent(listing.providerId))}/${escapeHtml(encodeURIComponent(listing.modelId))}">${escapeHtml(listing.entry.name)} <code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code></a> ${eligibilityBadge(described)} ${escapeHtml(ratingLine(listing.rating))}</li>`;
        })
        .join("\n")}\n</ul>\n${pageNav(active, total, limit, offset, listings.length)}</section>`;
  }
  const body = `<div class="preview-banner" role="note">Preview build: stub data only.</div>
<h1>Listings</h1>
${filterForm(filters, pageInfo)}
${results}`;
  // TOG-6044: `/listings` vs `/listings/` serve the same body — pin the
  // slashless path as canonical. Filtered/paged views consolidate to the
  // same bare-index canonical (stub preview: no per-variant indexing).
  return layout({ title: "Listings", body, cspNonce: pageNonce(options), canonical: "/listings" });
}
