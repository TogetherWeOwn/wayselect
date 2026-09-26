// Deterministic CLI failure copy for Wayselect (TOG-5058).
//
// Both CLIs (bin/wayselect, bin/wayselect-snapshot) build every user-facing
// failure line from these builders and render it as `<Name>: <message>\n` on
// stderr with exit code 1. No model calls, no network, no guessing: the same
// input always yields the same bytes.
//
// Success paths are out of scope here: they print JSON to stdout with empty
// stderr. Stale/future catalogs on bin/wayselect are also NOT failures — they
// yield a `no-eligible-route` JSON decision with null transport.

export function missingValueMessage(flag) {
  return `Missing value for ${flag}`;
}

export function unknownArgumentMessage(flag) {
  return `Unknown argument: ${flag}`;
}

export function invalidMaxCatalogAgeMessage() {
  return "--max-catalog-age-hours must be a non-negative number";
}

export function staleSnapshotMessage(ageMs, maxCatalogAgeMs) {
  return `refusing stale staging snapshot: age ${ageMs}ms exceeds limit ${maxCatalogAgeMs}ms`;
}

export function futureSnapshotMessage(ageMs, maxCatalogAgeMs) {
  return `refusing future-dated staging snapshot: age ${ageMs}ms exceeds limit ${maxCatalogAgeMs}ms`;
}

export function failOnGapsMessage(gapCount) {
  return `snapshot reports ${gapCount} provenance gap(s); failing on --fail-on-gaps`;
}

export function formatCliFailure(error) {
  return `${error.name}: ${error.message}\n`;
}
