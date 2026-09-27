# `wayselect` CLI

> **Dry-run / synthetic estimate.** Every command below is fixture-only: no live
> model calls, no credentials, no network use. Selected rates are
> synthetic/list-price estimates only — not actual cost or savings.

The CLI is a thin wrapper: `bin/wayselect` parses arguments, loads the fixture
files, calls `selectRoute`, and formats the result. All examples run from the
repo root against the checked-in fixtures. Pin `--evaluation-time` to keep
output deterministic. Ranking ties break by UTF-16 code-unit route-ID order
(`src/routeId.js`) — identical on every machine regardless of locale.

## `select`: pick a route, show ranked candidates

```sh
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-26T16:00:00.000Z
```

```text
dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use
Selected route: northstar/alpha-chat
Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id
Rates are synthetic/list-price estimates only; not actual cost or savings.

Ranked candidates (2 eligible, 4 excluded):
  1. northstar/alpha-chat — eligible, est. 3 / million tokens
  2. orbit/orbit-chat — eligible, est. 3 / million tokens
  3. legacy/old-chat — excluded (provider-not-allowed, stale-evidence)
  4. northstar/image-lite — excluded (operation-not-catalogued, operation-not-configured, unsupported-capability:toolUse)
  5. northstar/unknown-tools — excluded (missing-capability:toolUse)
  6. orbit/retired-chat — excluded (support-state:unsupported, operation-not-configured)

Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-26T14:00:00.000Z
```

`select` with no arguments reads the demo request file
(`fixtures/request.synthetic.json`) and prints the same result:

```sh
node bin/wayselect select
```

## `explain`: per-candidate eligibility detail

```sh
node bin/wayselect explain --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-26T16:00:00.000Z
```

```text
dry-run explain — dry-run / synthetic estimate — no live model calls, credentials, or network use
Request: operation=chat, require=[toolUse], allow=[northstar, orbit]
Evaluation time: 2026-09-26T16:00:00.000Z, max evidence age: 72h

northstar/alpha-chat: eligible (provider northstar, support configured, est. 3 / million tokens)
orbit/orbit-chat: eligible (provider orbit, support conformance-tested, est. 3 / million tokens)
legacy/old-chat: excluded (provider legacy, support configured, est. 2 / million tokens)
  - provider-not-allowed
  - stale-evidence
northstar/image-lite: excluded (provider northstar, support configured, est. 2 / million tokens)
  - operation-not-catalogued
  - operation-not-configured
  - unsupported-capability:toolUse
northstar/unknown-tools: excluded (provider northstar, support configured, est. 0.75 / million tokens)
  - missing-capability:toolUse
orbit/retired-chat: excluded (provider orbit, support unsupported, est. 0.2 / million tokens)
  - support-state:unsupported
  - operation-not-configured

verdict: selected northstar/alpha-chat
Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-26T14:00:00.000Z
```

## `--json`: machine-readable output

Both subcommands accept `--json`. The shape is identical apart from `command`:

```sh
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-26T16:00:00.000Z --json
```

```json
{
  "command": "select",
  "dryRun": true,
  "dryRunLabel": "dry-run / synthetic estimate — no live model calls, credentials, or network use",
  "status": "selected",
  "selectedRouteId": "northstar/alpha-chat",
  "policy": "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
  "rateDisclaimer": "Synthetic/list-price estimates only; not actual cost or savings.",
  "provenance": {
    "source": "synthetic://wayselect/fixture-v1",
    "snapshotTimestamp": "2026-09-26T14:00:00.000Z",
    "snapshotHash": "sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d"
  },
  "request": {
    "operation": "chat",
    "requiredCapabilities": ["toolUse"],
    "providerAllowlist": ["northstar", "orbit"]
  },
  "evaluationTime": "2026-09-26T16:00:00.000Z",
  "maxEvidenceAgeHours": 72,
  "rankedCandidates": [
    {
      "rank": 1,
      "routeId": "northstar/alpha-chat",
      "providerId": "northstar",
      "modelId": "alpha-chat",
      "supportState": "configured",
      "eligible": true,
      "estimatedRatePerMillion": 3,
      "reasons": []
    }
  ]
}
```

(`rankedCandidates` lists all six routes; eligible candidates sort lowest synthetic rate first, then lexicographic route ID; excluded routes retain catalog order. `provenance.fetchedAt` is stamped at evaluation time — expect a live wall-clock value there.)

## Requirements via flags or a request file

Requirements come from `--request` or from flags; flags override the file.

- `--request <path>` accepts a full demo request (with `selection`,
  `evaluationTime`, `maxEvidenceAgeHours`, `maxCatalogAgeHours`) or a bare
  selection (`operation`, `requiredCapabilities`, `providerAllowlist`).
- `--operation <name>` sets the operation.
- `--require <cap,...>` is repeatable and comma-separated; it replaces the
  file's required capabilities.
- `--allow <provider,...>` is repeatable and comma-separated; it replaces the
  file's provider allowlist.
- `--evaluation-time <iso>` and `--max-evidence-age-hours <n>` override the
  evaluation timestamp and freshness limit (default 72h).
- `--max-catalog-age-hours <n>` overrides the catalog freshness limit
  (explicit flag wins, otherwise the request's `maxCatalogAgeHours`, otherwise
  24h). Stale or future-dated catalogs fail closed: every candidate is
  excluded with `stale-catalog`/`future-catalog`, the verdict is
  no-eligible-route, and the exit code is 3.

```sh
# Fully from flags (no request file):
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-26T16:00:00.000Z

# Bare selection file plus an override:
node bin/wayselect explain --request fixtures/request.synthetic.json \
  --allow northstar
```

## Typed capability requirements (capability-aware select, S1)

`select` and `explain` filter catalog entries against typed requirements
(spec R1), from flags or from a request file's `requirements` object. Missing
or unknown capability data fails closed: the entry is excluded with an
explicit reason, never silently included (spec R2).

- `--input-modalities <m,...>` / `--output-modalities <m,...>` — repeatable,
  comma-separated; every listed modality must appear in the candidate's
  normalized `modalities` (otherwise `missing-modality:input:<value>`).
- `--min-context-window <n>` / `--max-output-tokens <n>` — the candidate's
  `limits` must meet the threshold. Unknown limits report
  `missing-capability:contextWindow` / `missing-capability:maxOutputTokens`;
  a short limit reports `insufficient-context-window` /
  `insufficient-max-output-tokens`.
- `--require-tools`, `--require-structured-output`, `--require-reasoning` —
  checked against the normalized `toolUse`, `structuredOutput`, and
  `reasoning` flags (`missing-capability:` / `unsupported-capability:`).
  Absent means no constraint.
- Malformed flag values fail closed at the CLI boundary (exit 1); unknown
  `requirements` keys in a request file are rejected the same way.

```sh
# Fully-qualifying modalities pick the image route (exit 0):
node bin/wayselect select --operation vision-chat --allow northstar \
  --input-modalities image --output-modalities text \
  --evaluation-time 2026-09-26T16:00:00.000Z

# Unknown limits fail closed: the pinned fixture carries no context_window
# fields, so every candidate is excluded (exit 3):
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --min-context-window 10000000 \
  --evaluation-time 2026-09-26T16:00:00.000Z --json

# explain names the typed requirements on its Request line:
node bin/wayselect explain --operation chat --allow northstar,orbit \
  --require-tools --input-modalities text \
  --evaluation-time 2026-09-26T16:00:00.000Z
```

```text
Request: operation=chat, require=[], allow=[northstar, orbit], typed=[inputModalities=[text], toolCalling]
```

A request file may carry the same constraints as a `requirements` object
(`inputModalities`, `outputModalities`, `minContextWindow`,
`maxOutputTokens`, `toolCalling`, `structuredOutput`, `reasoning`); flags
override the file per dimension, mirroring `--require`/`--allow`.

## `catalog import`: ingest models.dev-shaped JSON

```sh
node bin/wayselect catalog import models.json \
  --source "https://models.dev/api.json" \
  --snapshot-timestamp 2026-09-24T10:00:00.000Z \
  --out catalog.json
```

`catalog import` maps provider-keyed, models.dev-shaped JSON (providers →
models with modalities, limits, tool/structured-output flags, and list
prices) onto the normalized catalog schema and writes a
`{ provenance, catalog }` document. It is a dry-run adapter, not a
configuration step:

- Default reads a local file. `--fetch` fetches `https://models.dev/api.json`
  (overridable with `--fetch-url`) and is the only networked path in the CLI —
  explicit opt-in, never exercised in tests.
- Every ingested entry lands as support state `catalogued` only — ingestion
  never configures, enables, or produces executable URLs.
- models.dev `limit: { context, output }` maps onto `context_window` /
  `max_output_tokens`. Known upstream extras are stripped at the boundary:
  sibling pricing metadata beyond input/output list prices, URL-bearing
  `api`/`endpoint`/`doc` fields, and `temperature`/`knowledge`/`release_date`/
  `open_weights` card metadata. Anything else unknown or malformed quarantines
  the entry with a named reason; capabilities are never guessed.
- Provenance: `--source` defaults to the `file://` input path (or the fetch
  URL with `--fetch`), `--snapshot-timestamp` defaults to now, and
  `--snapshot-hash` defaults to the canonical SHA-256 hash of the ingested
  mapping — the same gate `normalizeCatalog` verifies, so a default import
  always round-trips. An explicit `--snapshot-hash` that does not match the
  ingested body fails closed instead of writing an unverifiable document.

Example (one entry ingested, one quarantined for an unknown field):

```sh
node bin/wayselect catalog import models.json --source doc-example \
  --snapshot-timestamp 2026-09-24T10:00:00.000Z
```

```text
catalog import — dry-run only (support state: catalogued only)
Source: doc-example @ 2026-09-24T10:00:00.000Z
Snapshot hash: sha256:2007ad13…
Raw input hash: sha256:b8b4ecc6…
Ingested 1 entry from 1 provider (support state: catalogued only).
Quarantined 1:
  - acme/mystery: provider acme model mystery contains unknown field: frobnicate
No --out path given; catalog document not written.
```

`--json` emits the machine-readable summary instead (`command`,
`networkUsed`, `source`, `snapshotTimestamp`, `snapshotHash`, `rawHash`,
`providerCount`, `entryCount`, `quarantined` with per-entry reasons,
`outPath`). `--out <path>` writes the catalog document; without it nothing is
written. Failures render as `<Name>: <message>` on stderr with exit code 1
(unreadable file, bad JSON, failed validation, mismatched snapshot hash, or
zero surviving entries). `catalog --help` prints the same usage.

## Exit codes

| Code | Meaning | Example |
| --- | --- | --- |
| 0 | a route was selected (or help/version shown) | `wayselect select --operation chat --require toolUse --allow northstar,orbit --evaluation-time 2026-09-26T16:00:00.000Z` |
| 1 | invalid input: unreadable file, bad JSON, failed validation | `wayselect select --request fixtures/missing.json` |
| 2 | usage error: unknown subcommand/flag, missing value | `wayselect frobnicate`; `wayselect select --nope` |
| 3 | no eligible route — output is still printed | `wayselect select --operation chat --require vision --allow northstar` |

No-eligible-route example:

```sh
node bin/wayselect select --operation chat --require vision --allow northstar \
  --evaluation-time 2026-09-26T16:00:00.000Z; echo "exit=$?"
```

(Pin `--evaluation-time`: without it the CLI evaluates at the wall clock,
which the catalog freshness gate correctly refuses as stale once the
fixtures age past 24h. Per-reason detail may also vary with the wall clock
— `stale-evidence` appears only while the evidence window still covers a
candidate — while the exit code and verdict stay stable.)

```text
dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use
No eligible route.
Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id
Rates are synthetic/list-price estimates only; not actual cost or savings.

Ranked candidates (0 eligible, 6 excluded):
  1. legacy/old-chat — excluded (provider-not-allowed, missing-capability:vision, stale-evidence)
  2. northstar/alpha-chat — excluded (missing-capability:vision)
  3. northstar/image-lite — excluded (operation-not-catalogued, operation-not-configured, missing-capability:vision)
  4. northstar/unknown-tools — excluded (missing-capability:vision)
  5. orbit/orbit-chat — excluded (provider-not-allowed, missing-capability:vision)
  6. orbit/retired-chat — excluded (support-state:unsupported, provider-not-allowed, operation-not-configured, missing-capability:vision)

Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-26T14:00:00.000Z
exit=3
```

## `--help` and `--version`

```sh
node bin/wayselect --help      # global usage, all flags, exit codes
node bin/wayselect select --help   # command usage
node bin/wayselect --version   # prints "wayselect <version>"
```
