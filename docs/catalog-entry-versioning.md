# Catalog-entry schema versioning (TOG-5742)

`schema/catalog-entry/v1.json` is the pinned machine contract for a single
ingested models.dev catalog entry, enforced by
[`src/validate-catalog-entry.js`](../src/validate-catalog-entry.js).
Consumers pin against it; breaking changes must be declared, never silent.

## What is pinned

- Structural schema: [`schema/catalog-entry/v1.json`](../schema/catalog-entry/v1.json).
  `additionalProperties` is `false` at every object level, so any added,
  removed, or renamed field fails validation.
- Version pin: `schemaVersion` must equal exactly `"v1"` — enforced twice,
  by the `const: "v1"` in the schema file and by the `SCHEMA_VERSION` guard in
  the validator, which rejects before AJV runs so even a structurally valid
  non-v1 entry never reads as eligible.
- Rejection provenance: every rejection names `source` + `fetchedAt`, so stale
  or unauthorized entries are traceable to the feed or fixture they came from.
- Tests: [`test/validate-catalog-entry.test.js`](../test/validate-catalog-entry.test.js)
  pins the v1 acceptance and the stale-version rejection directly.

## Version negotiation (no silent upgrades)

There is no negotiation at runtime: the validator accepts exactly the pinned
version and rejects everything else fail-closed — older (`v0`), newer (`v2`),
or missing `schemaVersion`. A feed that starts emitting a new version stops
being ingested (loudly, with provenance) instead of being half-understood.

## Bump procedure (how v2 would land)

1. Copy the schema: `schema/catalog-entry/v1.json` → `schema/catalog-entry/v2.json`,
   update its `$id`/`title`/`description`. Old versions stay checked in.
2. Point `src/validate-catalog-entry.js` at the new file (and its
   `SCHEMA_VERSION`), in the same commit.
3. Update the pin tests and name the breaking change in the PR description so
   downstream consumers can adapt.
4. Run `npm test` green before requesting review.
