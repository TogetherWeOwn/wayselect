// Listing-detail page renderer for the Wayselect web slice (TOG-4882) with
// per-model eligibility display (TOG-5221).
//
// Pure functions: listing in, HTML string out. All dynamic values are
// HTML-escaped. The purchase CTA is a stub — a disabled form that posts to a
// route which refuses with 403. No backend writes anywhere on this page.
//
// Eligibility is a read-only display over existing capability-check output
// (web/eligibility.js consuming src/eligibility.js): granted / blocked /
// unknown badges with fail-closed copy on unknown. Rendering never throws:
// an evaluation failure degrades to unknown.

import {
  ELIGIBILITY_STATE,
  describeEligibility,
  evaluateListingEligibility,
  evaluateListingsEligibility,
} from "./eligibility.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
</style>
</head>
<body>
<main>
${body}
</main>
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

export function renderListingDetail(listing, evaluationOverride) {
  const { entry } = listing;
  const title = `${entry.name} (${listing.providerId}/${listing.modelId})`;
  const inputModalities = Array.isArray(entry.modalities?.input) ? entry.modalities.input : [];
  const outputModalities = Array.isArray(entry.modalities?.output) ? entry.modalities.output : [];
  const modalities = [...inputModalities, ...outputModalities].filter(
    (value, index, all) => all.indexOf(value) === index,
  );

  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No purchase is processed.</div>
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
<form method="post" action="/listings/${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}/purchase">
<button type="submit" disabled aria-disabled="true" title="Disabled in preview">Purchase (stub — disabled in preview)</button>
</form>
<p>No backend writes: the purchase endpoint refuses with <code>403 preview_only</code> while the flag gates this page.</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;

  return layout({ title, body });
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

export function renderListingIndex(listings, evaluationsOverride) {
  const evaluations = resolveIndexEvaluations(listings, evaluationsOverride);
  const items = listings
    .map((listing) => {
      const described = describeEligibility(
        evaluations.get(`${listing.providerId}/${listing.modelId}`) ?? null,
      );
      return `<li><a href="/listings/${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}">${escapeHtml(listing.entry.name)} <code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code></a> ${eligibilityBadge(described)}</li>`;
    })
    .join("\n");
  const body = `<div class="preview-banner" role="note">Preview build: stub data only.</div>
<h1>Listings</h1>
<ul>
${items}
</ul>`;
  return layout({ title: "Listings", body });
}
