# CLI `--json` machine contract (TOG-5734, TOG-7302, TOG-8326)

`wayselect select --json` / `wayselect explain --json` /
`wayselect catalog import --json` is a versioned machine interface.
Consumers pin against it; breaking changes must be declared, never silent.

## What is pinned

- Structural schema: [`schema/cli-json/v1.json`](../schema/cli-json/v1.json),
  enforced by [`src/validate-cli-json.js`](../src/validate-cli-json.js).
  The schema is a `command`-dispatched union (`select`/`explain` share the
  selection shape; `catalog import` has the import shape).
  `additionalProperties` is `false` at every object level, so any added,
  removed, or renamed field fails validation.
- Cross-field invariants the structural schema cannot express (checked in the
  same validator, select/explain only): `status: selected` requires a non-null
  `selectedRouteId` matching the top-ranked candidate; `no-eligible-route`
  requires null; `rank` is 1..N in order; eligible candidates carry zero
  reasons, excluded candidates carry at least one.
- Value snapshots: [`test/fixtures/cli-json-select.v1.json`](../test/fixtures/cli-json-select.v1.json),
  [`test/fixtures/cli-json-explain.v1.json`](../test/fixtures/cli-json-explain.v1.json),
  [`test/fixtures/cli-json-no-route.v1.json`](../test/fixtures/cli-json-no-route.v1.json),
  [`test/fixtures/cli-json-catalog-import.v1.json`](../test/fixtures/cli-json-catalog-import.v1.json)
  — byte-level snapshots of live CLI output with volatile fields scrubbed
  (the import fixture is fully deterministic: fixed `--source` /
  `--snapshot-timestamp` over a temp-dir input, so nothing is scrubbed).
- In-band version marker: every payload carries top-level `schemaVersion`
  (`const: "v1"` in the schema, mirroring `SCHEMA_VERSION` in
  `src/validate-cli-json.js`). Consumers pin on this marker instead of
  sniffing the shape; a breaking change bumps the version per the procedure
  below, never silently. Pinned by
  [`test/cli-json-schema-version.test.js`](../test/cli-json-schema-version.test.js)
  (live select/explain/import output carries the marker and validates; the
  validator rejects a dropped or wrong marker; `SCHEMA_VERSION` itself is
  pinned to `"v1"` so a bump edits the test deliberately).
- Tests: [`test/cli-json-contract.test.js`](../test/cli-json-contract.test.js)
  runs the CLI against the checked-in fixtures, validates the output against
  the schema, and compares it byte-for-byte to the snapshots.

Volatile by design (normalized away before comparison, asserted well-formed
separately): ISO timestamps (`evaluationTime`, `provenance.snapshotTimestamp`,
`provenance.fetchedAt`) and `provenance.snapshotHash` — these move on every
fixture refresh. Also, snapshot fixtures store the `fetchedAt` placeholder
`<fetchedAt: wall-clock at evaluation, any ISO timestamp>` instead of a live
value. Everything else — commands, statuses, policies, ranks, reasons, rates —
is refresh-stable and compared exactly.

## Bump procedure (intentional shape change)

1. Change `bin/wayselect` output and update `docs/cli.md`'s `--json` example
   in the same commit.
2. Copy the schema: `schema/cli-json/v1.json` → `schema/cli-json/v2.json`,
   update its `$id`/`title`/`description`, and point
   `src/validate-cli-json.js` at the new file (and its `SCHEMA_VERSION`).
   Old versions stay checked in.
3. Regenerate the snapshots: run the three CLI invocations from
   `test/cli-json-contract.test.js` (`SELECT_ARGS`, explain, `NO_ROUTE_ARGS`)
   with the suite clock and scrub `fetchedAt` to the placeholder.
4. Run `npm test` green and name the breaking change in the PR description so
   downstream consumers can adapt.
