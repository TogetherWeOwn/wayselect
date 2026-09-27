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

// Paging bounds for the listing index (TOG-6028): the index renders HTML, so
// an unbounded catalog means an unbounded page. `limit`/`offset` keep every
// render bounded; over-max and malformed values fail closed (400 upstream).
export const LISTINGS_DEFAULT_LIMIT = 20;
export const LISTINGS_MAX_LIMIT = 100;
export const LISTINGS_DEFAULT_OFFSET = 0;

// Text-query bound (TOG-6370, P2/G9): `q` arrives from the URL bar and
// `normalizeFilters` below previously accepted it unbounded — an
// attacker-sized value flows into matching, the reflected form value, and
// logs. Over-long values fail closed (400 upstream) naming this bound; the
// echoed value is truncated so the error page itself stays bounded. 200 is
// ~10x headroom over realistic listing-search terms, same order as the
// intake free-string caps (buyer ≤120, etag ≤256 in src/intakeLimits.js).
export const LISTINGS_MAX_QUERY_LENGTH = 200;

// Known /listings query keys (TOG-6365): anything else is a typo failing
// silently, so unknown keys fail closed (400 upstream) naming this list.
export const VALID_LISTINGS_QUERY_PARAMS = Object.freeze([
  "q",
  "capability",
  "modality",
  "limit",
  "offset",
]);

const CAPABILITY_SET = new Set(VALID_CAPABILITIES);
const MODALITY_SET = new Set(VALID_MODALITIES);
const QUERY_PARAM_SET = new Set(VALID_LISTINGS_QUERY_PARAMS);

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

// Parse one paging param: absent means the default; present must be an
// ASCII digit string (no signs, decimals, or whitespace padding that hides
// them) and a safe integer. Returns `{ ok: true, value }` or
// `{ ok: false, raw }` for the 400 invalid-filter page (fail closed).
function parsePagingParam(raw, fallback) {
  if (raw === null) {
    return { ok: true, value: fallback };
  }
  const text = raw;
  if (!/^\d+$/.test(text)) {
    return { ok: false, raw };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, raw };
  }
  return { ok: true, value };
}

// Validate raw query params. Returns `{ ok: true, filters, paging }` or
// `{ ok: false, errors }` for the 400 invalid-filter page, where `errors`
// collects EVERY problem (TOG-6374, Gap A4) so the HTML page can present
// them all instead of just the first. Each entry is
// `{ kind, value, valid }`. The top-level `kind`/`value`/`valid` mirror the
// first error for backward compatibility with existing callers/tests.
export function parseListingsQuery(searchParams) {
  const errors = [];
  for (const key of new Set(searchParams.keys())) {
    if (!QUERY_PARAM_SET.has(key)) {
      errors.push({ kind: "query", value: key, valid: VALID_LISTINGS_QUERY_PARAMS });
    }
  }
  const filters = normalizeFilters({
    q: searchParams.get("q") ?? "",
    capabilities: searchParams.getAll("capability"),
    modalities: searchParams.getAll("modality"),
  });
  // Fail closed on oversize q: the echoed value is truncated so the 400
  // page itself stays bounded no matter how large the input is.
  if (filters.q.length > LISTINGS_MAX_QUERY_LENGTH) {
    errors.push({
      kind: "q",
      value: filters.q.slice(0, 64),
      valid: [`at most ${LISTINGS_MAX_QUERY_LENGTH} characters`],
    });
  }
  for (const name of filters.capabilities) {
    if (!CAPABILITY_SET.has(name)) {
      errors.push({ kind: "capability", value: name, valid: VALID_CAPABILITIES });
    }
  }
  for (const name of filters.modalities) {
    if (!MODALITY_SET.has(name)) {
      errors.push({ kind: "modality", value: name, valid: VALID_MODALITIES });
    }
  }
  const limit = parsePagingParam(searchParams.get("limit"), LISTINGS_DEFAULT_LIMIT);
  if (!limit.ok || limit.value < 1 || limit.value > LISTINGS_MAX_LIMIT) {
    errors.push({
      kind: "limit",
      value: limit.ok ? String(limit.value) : (limit.raw ?? ""),
      valid: [`1-${LISTINGS_MAX_LIMIT}`],
    });
  }
  const offset = parsePagingParam(searchParams.get("offset"), LISTINGS_DEFAULT_OFFSET);
  if (!offset.ok) {
    errors.push({ kind: "offset", value: offset.raw ?? "", valid: ["0 or greater"] });
  }
  if (errors.length > 0) {
    const [first] = errors;
    return {
      ok: false,
      kind: first.kind,
      value: first.value,
      valid: first.valid,
      errors,
    };
  }
  return { ok: true, filters, paging: { limit: limit.value, offset: offset.value } };
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

// Slice a filtered result to the requested window (TOG-6028). Offset past
// the end yields an empty page (never a 400); the total is kept so the
// renderer can announce the full match count alongside the window.
export function paginateListings(listings, paging) {
  const total = listings.length;
  const limit =
    Number.isSafeInteger(paging?.limit) && paging.limit > 0 ? paging.limit : LISTINGS_DEFAULT_LIMIT;
  const offset =
    Number.isSafeInteger(paging?.offset) && paging.offset >= 0
      ? paging.offset
      : LISTINGS_DEFAULT_OFFSET;
  const page = listings.slice(offset, offset + limit);
  return { page, total, limit, offset };
}
