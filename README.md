# Wayselect

> **Early development: fixture-only and dry-run only.** Wayselect does not call models, store credentials, discover endpoints, or claim production compatibility, savings, or optimal routing.

Wayselect is a small Node 20+ ES module library with a thin local CLI. It turns a newly authored synthetic, models.dev-shaped catalog fixture into an explicit support configuration, applies fail-closed eligibility rules, and returns an inspectable selection explanation. The only transport in this slice is an in-memory fake adapter.

## What this slice proves

- Catalog input is normalized at one boundary and carries `source`, snapshot timestamp, and SHA-256-shaped provenance.
- Catalog presence stays `catalogued`; it does not imply permission, configuration, conformance, or availability.
- Executable candidates must have an explicit support state, configured operations, fresh evidence, and an explicit provider allowlist.
- Missing capability data, unsupported operations, stale evidence, and disallowed providers fail closed with stable reason codes.
- Selection is deterministic: lowest synthetic/list-price estimate first, then lexicographic route ID for ties.
- Catalog records and fake-transport routes cannot carry executable URL fields.
- The fixture demo runs with Node standard library only and performs no network access.

## Support states

| State | Meaning in this slice | Eligible? |
| --- | --- | --- |
| `catalogued` | Present in a normalized catalog only | No |
| `configured` | Explicitly configured for named operations | Yes, if every other rule passes |
| `conformance-tested` | Explicitly configured with recorded synthetic conformance evidence | Yes, if every other rule passes |
| `unavailable` | Known but currently unavailable | No |
| `unsupported` | Explicitly unsupported | No |

A support state is not a provider credential or permission grant. Evidence can also expire; stale or missing evidence excludes an otherwise configured candidate.

## Requirements

- Node.js 20 or newer
- No package installation
- No environment variables or credentials

## Reproducible local demo

```sh
node --version
npm test
npm run demo
```

The demo reads only:

- `fixtures/catalog.synthetic.json`
- `fixtures/configuration.synthetic.json`
- `fixtures/request.synthetic.json`

It prints JSON containing:

1. fixture provenance;
2. every candidate and its eligibility or exclusion reasons;
3. the deterministic selected route or `no-eligible-route`;
4. a response from `FakeTransport` with `networkUsed: false`.

Use alternate fixture files without adding code or network access:

```sh
node bin/wayselect \
  --catalog fixtures/catalog.synthetic.json \
  --configuration fixtures/configuration.synthetic.json \
  --request fixtures/request.synthetic.json
```

## Staging catalog snapshots and diffs

Staging-only automation with no network access and no production writes.
Snapshots reuse the `normalizeCatalog` boundary, record a recomputed
SHA-256 content hash, and report provenance gaps (unverified declared
hash, stale/future snapshot, missing capabilities, missing rates,
no catalogued operations). Non-`synthetic://` sources are refused.

```sh
node bin/wayselect-snapshot \
  --now 2026-09-24T12:00:00.000Z \
  --max-catalog-age-hours 24 \
  --out snapshots
node bin/wayselect-snapshot \
  --now 2026-09-24T12:05:00.000Z \
  --max-catalog-age-hours 24 \
  --out snapshots \
  --previous snapshots/snapshot-20260924T120000000Z-c6cdb62e.json
```

The second run writes a second snapshot plus a Markdown diff report
(added/removed/changed routes, gap deltas). A stale or future-dated
catalog fails closed instead of writing a snapshot. See
`snapshots/diff-report-consecutive-green.md` and
`snapshots/sample-diff-with-changes.md` for sample evidence.

## Library boundaries

- `src/catalog.js` validates a narrow provider-keyed, models.dev-shaped fixture subset and preserves provenance. Unknown fields are rejected at the boundary.
- `src/support.js` applies explicit support states and configured operation claims without mutating catalog evidence.
- `src/eligibility.js` applies operation, capability, provider, and evidence-age rules. An empty provider allowlist is invalid.
- `src/selection.js` produces a dry-run decision and full candidate explanations.
- `src/transport.js` exposes only `FakeTransport`; executable location fields are rejected.
- `bin/wayselect` is the reproducible fixture demo.

The normalized capability names are `attachment`, `reasoning`, `toolUse`, `structuredOutput`, `imageInput`, `textInput`, and `textOutput`. A required name not present in normalized data is reported as `missing-capability:<name>` and is never guessed.

## Explicit non-goals

This slice does not include live provider calls, endpoint discovery, credentials, HTTP servers, paid inference, real usage or billing data, third-party catalog redistribution, production deployment, universal compatibility, or a savings claim. Future transport or live-conformance work requires separate provenance, security, access, and review decisions.
