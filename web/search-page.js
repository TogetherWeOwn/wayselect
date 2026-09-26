// Search/filter page renderer for the preview-only slice (TOG-4916).
//
// Pure functions: fixtures + filters in, HTML string out. All dynamic values
// are HTML-escaped. No backend writes anywhere on this page.

import {
  CATEGORIES,
  DEFAULT_FILTERS,
  STATUSES,
  availableCategories,
  countByStatus,
  listingCategory,
  listingStatus,
} from "./search-filter.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
form.filters { display: grid; gap: 0.75rem; margin: 1rem 0 1.5rem; }
form.filters label { display: grid; gap: 0.25rem; font-weight: 600; }
form.filters input, form.filters select { font: inherit; padding: 0.5rem 0.6rem; }
.filters-row { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr; }
form.filters button { justify-self: start; font-size: 1rem; padding: 0.5rem 1.2rem; }
ul.results { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
ul.results li { border: 1px solid #888; border-radius: 0.5rem; padding: 0.75rem 1rem; }
.result-name { font-weight: 700; }
.result-meta { font-size: 0.9rem; }
.badge { display: inline-block; border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.85rem; }
.badge-stable { background: #d3f9d8; color: #1a4d1f; }
.badge-beta { background: #fff3bf; color: #6b4e00; }
.badge-deprecated { background: #f1f3f5; color: #495057; }
.empty { border: 1px dashed currentColor; border-radius: 0.5rem; padding: 1.5rem 1rem; }
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

function selectOptions(values, current, allLabel) {
  const all = `<option value="all"${current === "all" ? " selected" : ""}>${escapeHtml(allLabel)}</option>`;
  return (
    all +
    values
      .map(
        (value) =>
          `<option value="${escapeHtml(value)}"${current === value ? " selected" : ""}>${escapeHtml(value)}</option>`,
      )
      .join("")
  );
}

function resultItem(listing) {
  const status = listingStatus(listing);
  const category = listingCategory(listing);
  return `<li>
<div class="result-name">${escapeHtml(listing.entry.name)}</div>
<div class="result-meta"><code>${escapeHtml(listing.providerId)}/${escapeHtml(listing.modelId)}</code>
<span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span>
<span> · category: ${escapeHtml(category)}</span></div>
${listing.entry.description ? `<div class="result-meta">${escapeHtml(listing.entry.description)}</div>` : ""}
</li>`;
}

export function renderSearchPage({ listings, total, filters = {} }) {
  const active = { ...DEFAULT_FILTERS, ...filters };
  const categories = availableCategories(total);
  const counts = countByStatus(total);
  const hasActiveFilters =
    active.query !== "" || active.category !== "all" || active.status !== "all";

  const results =
    listings.length === 0
      ? `<div class="empty" role="status">
<p><strong>No listings match these filters.</strong></p>
<p>Try a different search term or clear a filter.${hasActiveFilters ? ` <a href="/listings">Clear all filters</a>.` : ""}</p>
</div>`
      : `<ul class="results">
${listings.map(resultItem).join("\n")}
</ul>`;

  const body = `<div class="preview-banner" role="note">Preview build: stub data only. Search and filters run locally in the preview server.</div>
<h1>Search listings</h1>
<form class="filters" method="get" action="/listings" role="search" aria-label="Search listings">
<label for="q">Search
<input type="search" id="q" name="q" value="${escapeHtml(active.query)}" placeholder="Name, provider, or keyword…" autocomplete="off">
</label>
<div class="filters-row">
<label for="category">Category
<select id="category" name="category">
${selectOptions(categories, CATEGORIES.includes(active.category) ? active.category : "all", "All categories")}
</select>
</label>
<label for="status">Status
<select id="status" name="status">
${selectOptions(STATUSES, active.status, "All statuses")}
</select>
</label>
</div>
<button type="submit">Apply filters</button>
</form>
<p role="status">Showing ${listings.length} of ${total.length} stub listings${hasActiveFilters ? " (filters applied)" : ""} — stable: ${counts.stable}, beta: ${counts.beta}, deprecated: ${counts.deprecated}.</p>
${results}`;

  return layout({ title: "Search listings", body });
}

export function renderPreviewDisabled() {
  const body = `<h1>Preview unavailable</h1>
<p>This page is behind the <code>WAYSELECT_PREVIEW</code> flag, which is currently off.</p>`;
  return layout({ title: "Preview unavailable", body });
}
