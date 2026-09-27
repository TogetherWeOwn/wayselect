// Search/filter parsing + matching for the Wayselect listing index (TOG-5459).
//
// Pure functions: URL query params in, validated filters / filtered listings
// out. Unknown capability/modality values fail closed (reported for a 400
// upstream), never ignored. Result order always preserves stub order.

export const VALID_CAPABILITIES = Object.freeze([
  "attachment",
  "reasoning",
  "tool_call",
  "structured_output",
]);

// Mirrors the catalog-entry v1 modality enum (schema/catalog-entry/v1.json).
export const VALID_MODALITIES = Object.freeze(["audio", "image", "pdf", "text", "video"]);

const CAPABILITY_SET = new Set(VALID_CAPABILITIES);
const MODALITY_SET = new Set(VALID_MODALITIES);

export function emptyFilters() {
  return { q: "", capabilities: [], modalities: [] };
}

function normalizeFilters(filters) {
  return {
    q: typeof filters?.q === "string" ? filters.q : "",
    capabilities: Array.isArray(filters?.capabilities) ? [...filters.capabilities] : [],
    modalities: Array.isArray(filters?.modalities) ? [...filters.modalities] : [],
  };
}

// Validate raw query params. Returns `{ ok: true, filters }` or
// `{ ok: false, kind, value, valid }` for the 400 invalid-filter page.
export function parseListingsQuery(searchParams) {
  const filters = normalizeFilters({
    q: searchParams.get("q") ?? "",
    capabilities: searchParams.getAll("capability"),
    modalities: searchParams.getAll("modality"),
  });
  for (const name of filters.capabilities) {
    if (!CAPABILITY_SET.has(name)) {
      return { ok: false, kind: "capability", value: name, valid: VALID_CAPABILITIES };
    }
  }
  for (const name of filters.modalities) {
    if (!MODALITY_SET.has(name)) {
      return { ok: false, kind: "modality", value: name, valid: VALID_MODALITIES };
    }
  }
  return { ok: true, filters };
}

function matchesText(listing, needle) {
  if (needle === "") {
    return true;
  }
  const haystacks = [
    listing.entry?.name ?? "",
    `${listing.providerId}/${listing.modelId}`,
    listing.providerName ?? "",
  ];
  return haystacks.some((haystack) => String(haystack).toLowerCase().includes(needle));
}

function matchesCapabilities(listing, names) {
  if (names.length === 0) {
    return true;
  }
  const entry = listing.entry ?? {};
  // Fail closed: only an explicit `true` keeps the listing; missing or false
  // values exclude it.
  return names.every((name) => entry[name] === true);
}

function matchesModalities(listing, names) {
  if (names.length === 0) {
    return true;
  }
  const input = listing.entry?.modalities?.input;
  const output = listing.entry?.modalities?.output;
  return names.every(
    (name) =>
      (Array.isArray(input) && input.includes(name)) ||
      (Array.isArray(output) && output.includes(name)),
  );
}

// AND across q × capabilities × modalities; stub order preserved.
export function applyListingsFilters(listings, filters) {
  const normalized = normalizeFilters(filters);
  const needle = normalized.q.trim().toLowerCase();
  return listings.filter(
    (listing) =>
      matchesText(listing, needle) &&
      matchesCapabilities(listing, normalized.capabilities) &&
      matchesModalities(listing, normalized.modalities),
  );
}
