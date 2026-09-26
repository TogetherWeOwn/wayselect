// Listing search + filter logic for the preview-only slice (TOG-4916).
//
// Pure functions: typed fixtures in, filtered fixtures out. No backend
// wiring, no DOM access here — the renderer and server call into this.
//
// Filter vocabulary:
//   query    — free text matched case-insensitively against model name,
//              model/provider ids, and description (substring).
//   category — the listing's primary input modality: text | image | audio |
//              video | pdf. Mirrors the catalog-entry v1 `modality` enum.
//              "all" (or missing) means no category filtering.
//   status   — catalog-entry v1 `status`: absent means stable. Accepted
//              filter values: "all" | "stable" | "beta" | "deprecated".
//              Unknown values fall back to "all" (fail-open on the filter,
//              never on the data).

export const CATEGORIES = Object.freeze(["text", "image", "audio", "video", "pdf"]);

export const STATUSES = Object.freeze(["stable", "beta", "deprecated"]);

export const DEFAULT_FILTERS = Object.freeze({
  query: "",
  category: "all",
  status: "all",
});

export function listingStatus(listing) {
  return listing?.entry?.status ?? "stable";
}

export function listingCategory(listing) {
  return listing?.entry?.modalities?.input?.[0] ?? "text";
}

function normalizeQuery(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeCategory(raw) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "all" || value === "") {
    return "all";
  }
  return CATEGORIES.includes(value) ? value : "all";
}

function normalizeStatus(raw) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "all" || value === "") {
    return "all";
  }
  return STATUSES.includes(value) ? value : "all";
}

export function normalizeFilters(raw = {}) {
  return {
    query: normalizeQuery(raw.query),
    category: normalizeCategory(raw.category),
    status: normalizeStatus(raw.status),
  };
}

function matchesQuery(listing, query) {
  if (!query) {
    return true;
  }
  const haystack = [listing?.entry?.name, listing?.modelId, listing?.providerId, listing?.entry?.description]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function filterListings(listings, rawFilters = {}) {
  const filters = normalizeFilters(rawFilters);
  return listings.filter(
    (listing) =>
      matchesQuery(listing, filters.query) &&
      (filters.category === "all" || listingCategory(listing) === filters.category) &&
      (filters.status === "all" || listingStatus(listing) === filters.status),
  );
}

export function availableCategories(listings) {
  const seen = new Set();
  for (const listing of listings) {
    seen.add(listingCategory(listing));
  }
  return CATEGORIES.filter((category) => seen.has(category));
}

export function countByStatus(listings) {
  const counts = { stable: 0, beta: 0, deprecated: 0 };
  for (const listing of listings) {
    const status = listingStatus(listing);
    if (status in counts) {
      counts[status] += 1;
    }
  }
  return Object.freeze(counts);
}
