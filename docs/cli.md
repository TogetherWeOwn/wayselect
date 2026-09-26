# `wayselect` CLI

> **Dry-run / synthetic estimate.** Every command below is fixture-only: no live
> model calls, no credentials, no network use. Selected rates are
> synthetic/list-price estimates only — not actual cost or savings.

The CLI is a thin wrapper: `bin/wayselect` parses arguments, loads the fixture
files, calls `selectRoute`, and formats the result. All examples run from the
repo root against the checked-in fixtures. Pin `--evaluation-time` to keep
output deterministic.

## `select`: pick a route, show ranked candidates

```sh
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-24T12:00:00.000Z
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

Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-24T10:00:00.000Z
```

`select` with no arguments reads the demo request file
(`fixtures/request.synthetic.json`) and prints the same result:

```sh
node bin/wayselect select
```

## `explain`: per-candidate eligibility detail

```sh
node bin/wayselect explain --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-24T12:00:00.000Z
```

```text
dry-run explain — dry-run / synthetic estimate — no live model calls, credentials, or network use
Request: operation=chat, require=[toolUse], allow=[northstar, orbit]
Evaluation time: 2026-09-24T12:00:00.000Z, max evidence age: 72h

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
Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-24T10:00:00.000Z
```

## `--json`: machine-readable output

Both subcommands accept `--json`. The shape is identical apart from `command`:

```sh
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-24T12:00:00.000Z --json
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
    "snapshotTimestamp": "2026-09-24T10:00:00.000Z",
    "snapshotHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "request": {
    "operation": "chat",
    "requiredCapabilities": ["toolUse"],
    "providerAllowlist": ["northstar", "orbit"]
  },
  "evaluationTime": "2026-09-24T12:00:00.000Z",
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

(`rankedCandidates` continues for all six routes, lowest synthetic rate first,
then lexicographic route ID.)

## Requirements via flags or a request file

Requirements come from `--request` or from flags; flags override the file.

- `--request <path>` accepts a full demo request (with `selection`,
  `evaluationTime`, `maxEvidenceAgeHours`) or a bare selection
  (`operation`, `requiredCapabilities`, `providerAllowlist`).
- `--operation <name>` sets the operation.
- `--require <cap,...>` is repeatable and comma-separated; it replaces the
  file's required capabilities.
- `--allow <provider,...>` is repeatable and comma-separated; it replaces the
  file's provider allowlist.
- `--evaluation-time <iso>` and `--max-evidence-age-hours <n>` override the
  evaluation timestamp and freshness limit (default 72h).

```sh
# Fully from flags (no request file):
node bin/wayselect select --operation chat --require toolUse \
  --allow northstar,orbit --evaluation-time 2026-09-24T12:00:00.000Z

# Bare selection file plus an override:
node bin/wayselect explain --request fixtures/request.synthetic.json \
  --allow northstar
```

## Exit codes

| Code | Meaning | Example |
| --- | --- | --- |
| 0 | a route was selected (or help/version shown) | `wayselect select --operation chat --require toolUse --allow northstar,orbit --evaluation-time 2026-09-24T12:00:00.000Z` |
| 1 | invalid input: unreadable file, bad JSON, failed validation | `wayselect select --request fixtures/missing.json` |
| 2 | usage error: unknown subcommand/flag, missing value | `wayselect frobnicate`; `wayselect select --nope` |
| 3 | no eligible route — output is still printed | `wayselect select --operation chat --require vision --allow northstar` |

No-eligible-route example:

```sh
node bin/wayselect select --operation chat --require vision --allow northstar; echo "exit=$?"
```

```text
dry-run select — dry-run / synthetic estimate — no live model calls, credentials, or network use
No eligible route.
Policy: lowest-synthetic-estimated-rate-then-lexicographic-route-id
Rates are synthetic/list-price estimates only; not actual cost or savings.

Ranked candidates (0 eligible, 6 excluded):
  1. legacy/old-chat — excluded (provider-not-allowed, missing-capability:vision, stale-evidence)
  2. northstar/alpha-chat — excluded (missing-capability:vision, stale-evidence)
  3. northstar/image-lite — excluded (operation-not-catalogued, operation-not-configured, missing-capability:vision, stale-evidence)
  4. northstar/unknown-tools — excluded (missing-capability:vision, stale-evidence)
  5. orbit/orbit-chat — excluded (provider-not-allowed, missing-capability:vision, stale-evidence)
  6. orbit/retired-chat — excluded (support-state:unsupported, provider-not-allowed, operation-not-configured, missing-capability:vision)

Provenance: synthetic://wayselect/fixture-v1 @ 2026-09-24T10:00:00.000Z
exit=3
```

## `--help` and `--version`

```sh
node bin/wayselect --help      # global usage, all flags, exit codes
node bin/wayselect select --help   # command usage
node bin/wayselect --version   # prints "wayselect <version>"
```
