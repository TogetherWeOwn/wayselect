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
import { VALID_CAPABILITIES, VALID_MODALITIES, emptyFilters } from "./filter.js";

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

function layout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Wayselect</title>
<style>
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
a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; border-radius: 0.25rem; }
@media (forced-colors: active) { a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid Highlight; } }
.skeleton { border-radius: 0.375rem; background: linear-gradient(90deg, rgba(128, 128, 128, 0.28) 25%, rgba(128, 128, 128, 0.12) 50%, rgba(128, 128, 128, 0.28) 75%); background-size: 200% 100%; animation: skeleton-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
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

  return `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
<h1>${escapeHtml(entry.name)}</h1>
<p>Listing <code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code> from ${escapeHtml(listing.providerName)}.</p>
${eligibilitySection(listing, evaluationOverride)}
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
export function renderListingDetailShell(listing, evaluationOverride) {
  const { entry } = listing;
  const title = listingDetailTitle(listing);
  const routePath = `/listings/${encodeURIComponent(listing.providerId)}/${encodeURIComponent(listing.modelId)}`;
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
<script>
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

  return layout({ title, body });
}

// JSON fragment payload behind the shell: the full detail body as `html`,
// rendered from the same builder as the `<noscript>` branch so skeleton,
// noscript, and async content can never drift apart. Same route path —
export function listingDetailFragment(listing, evaluationOverride) {
  return { html: listingDetailBody(listing, evaluationOverride) };
}

export function renderListingDetail(listing, evaluationOverride) {
  return layout({
    title: listingDetailTitle(listing),
    body: listingDetailBody(listing, evaluationOverride),
  });
}

export function renderListingDetailError(providerId, modelId) {
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
<div role="alert">
<h1>Couldn&rsquo;t load listing details</h1>
<p>No stub listing data could be loaded for <code>${escapeHtml(providerId)}/${escapeHtml(modelId)}</code>. Please retry.</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Listing unavailable", body });
}

export function renderNotFound(providerId, modelId) {
  const body = `<h1>Listing not found</h1>
<p>No stub listing matches <code>${escapeHtml(providerId)}/${escapeHtml(modelId)}</code>.</p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Not found", body });
}

export function renderPreviewDisabled() {
  const body = `<h1>Preview unavailable</h1>
<p>This page is behind the <code>WAYSELECT_PREVIEW</code> flag, which is currently off.</p>`;
  return layout({ title: "Preview unavailable", body });
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
      return `<label><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked}> ${escapeHtml(label)}</label>`;
    })
    .join("\n");
}

function filterForm(filters) {
  const active = filters ?? emptyFilters();
  const q = typeof active.q === "string" ? active.q : "";
  const capabilities = Array.isArray(active.capabilities) ? active.capabilities : [];
  const modalities = Array.isArray(active.modalities) ? active.modalities : [];
  return `<form method="get" action="/listings" role="search" aria-label="Filter listings">
<label>Search <input type="text" name="q" value="${escapeHtml(q)}"></label>
<fieldset><legend>Capabilities</legend>
${checkboxRow("capability", VALID_CAPABILITIES, capabilities)}
</fieldset>
<fieldset><legend>Modalities</legend>
${checkboxRow("modality", VALID_MODALITIES, modalities)}
</fieldset>
<button type="submit">Apply filters</button>
<a href="/listings">Clear filters</a>
</form>`;
}

export function renderInvalidFilter({ kind, value, valid }) {
  const body = `<h1>Invalid filter</h1>
<p>Unknown ${escapeHtml(kind)} &quot;${escapeHtml(value)}&quot;. Valid values: ${valid.map(escapeHtml).join(", ")}.</p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Invalid filter", body });
}

// Paged navigation for the listing index (TOG-6028). `pageInfo` is the
// `{ total, limit, offset }` window the server sliced; without it the full
// array renders with the legacy "N listings found." copy. Prev/Next links
// preserve the active filters so paging never drops a filter.
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
  params.set("limit", String(limit));
  if (offset > 0) {
    params.set("offset", String(offset));
  }
  const qs = params.toString();
  return `/listings${qs ? `?${qs}` : ""}`;
}

function pageNav(filters, total, limit, offset, shown) {
  const links = [];
  if (offset > 0) {
    links.push(
      `<a href="${escapeHtml(pageHref(filters, limit, Math.max(0, offset - limit)))}">Previous</a>`,
    );
  }
  if (offset + shown < total) {
    links.push(
      `<a href="${escapeHtml(pageHref(filters, limit, offset + limit))}">Next</a>`,
    );
  }
  return links.length === 0 ? "" : `<nav aria-label="Listings pages"><p>${links.join(" ")}</p></nav>`;
}

export function renderListingIndex(listings, evaluationsOverride, filters, pageInfo) {
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
  if (listings.length === 0) {
    // Offset past the end is a valid empty page, not a filter miss: say so
    // and link back to the first page instead of blaming the filters.
    results =
      total > 0
        ? `<section aria-label="Results">\n<p role="status">${escapeHtml(countCopy)} found. No listings on this page.</p>\n<a href="${escapeHtml(pageHref(active, limit, 0))}">Back to first page</a>\n</section>`
        : `<section aria-label="Results">\n<p role="status">No listings match these filters.</p>\n<a href="/listings">Clear filters</a>\n</section>`;
  } else {
    const status =
      `${countCopy} found.` + (windowed ? ` Showing ${offset + 1}-${offset + listings.length}.` : "");
    results =
      `<section aria-label="Results">\n<p role="status">${escapeHtml(status)}</p>\n<ul>\n${listings
        .map((listing) => {
          const described = describeEligibility(
            evaluations.get(`${listing.providerId}/${listing.modelId}`) ?? null,
          );
          // S2 (TOG-5475, preserved through the main rebase): path
          // segments are URL-encoded inside the HTML escape so ids with
          // reserved characters keep working hrefs without XSS.
          return `<li><a href="/listings/${escapeHtml(encodeURIComponent(listing.providerId))}/${escapeHtml(encodeURIComponent(listing.modelId))}">${escapeHtml(listing.entry.name)} <code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code></a> ${eligibilityBadge(described)}</li>`;
        })
        .join("\n")}\n</ul>\n${pageNav(active, total, limit, offset, listings.length)}</section>`;
  }
  const body = `<div class="preview-banner" role="note">Preview build: stub data only.</div>
<h1>Listings</h1>
${filterForm(filters)}
${results}`;
  return layout({ title: "Listings", body });
}
