# `check-models-dev-freshness` no-network contract (TOG-6052, closes gap D3 from TOG-6013)

`bin/check-models-dev-freshness` (TOG-5551) diffs a saved models.dev catalog
copy against the ingested fixture snapshot and reports the freshness verdict.
Its offline mode (`--input`) performs **zero network I/O**. This doc pins that
contract for operators: what the script reads, what it never touches, and how
to verify offline. Proven by
[`test/models-dev-freshness-offline-contract.test.js`](../test/models-dev-freshness-offline-contract.test.js),
which runs on every `npm test`.

## What the script reads (offline mode)

`node bin/check-models-dev-freshness --input <file> [options]` reads only
local files:

| Input | Flag (default) | Notes |
| --- | --- | --- |
| Fixture snapshot to diff against | `--catalog` (default `fixtures/catalog.synthetic.json`) | Read via `readFile`, parsed as JSON, normalized with `normalizeCatalog` |
| Saved live-catalog copy | `--input <file>` (required in offline mode) | Read via `readFile`, parsed as JSON, extracted with `extractLiveRoutes`; reported as `fetchSource: file://<abs path>` |
| Evaluation clock | `--now <ISO>` (default: current time) | Pure date parsing; fails closed on invalid dates |
| Freshness window | `--max-catalog-age-hours <n>` (default `24`) | Pure number parsing; negative/NaN rejected |

The only write is the optional `--report <path>` Markdown file. Stdout gets
the report (or `--json` summary) and nothing else.

## What it never touches

- **Network:** the single networked call site in the whole probe path is
  `globalThis.fetch(url, …)` inside `fetchLiveCatalog`
  (`bin/check-models-dev-freshness:122`). It is reachable **only** when
  `--fetch` is passed: `main` branches on `args.fetch`, and the argument
  parser rejects `--fetch` combined with `--input` ("probe takes either
  --fetch or --input, not both") and requires one of them. `src/modelsDevProbe.js`
  (extract/diff/provenance/report) contains no `fetch`, no `node:http(s)`,
  no `node:net`/`node:dns`, and no subprocess calls — it is pure computation.
- **Catalog / routes / production:** read-only by construction. It never
  writes to the fixture, never configures routes, never touches production.
  The `--fetch` path itself is credential-free (public `https://models.dev/api.json`,
  default `DEFAULT_MODELS_DEV_URL`) with a 30 s abort timeout and no spend.
- **The offline report says so:** `--input` runs always print
  `network not used: file://…` and `--json` reports `"networkUsed": false`.

## How to verify offline (operator steps)

From the repo root, with the network disconnected (or DNS blocked — the
command must still pass). `--input` takes a models.dev-shaped provider map,
so carve it out of the stored snapshot first (the snapshot wraps it under
the `catalog` key — passing the whole snapshot file fails closed with
"no live routes survived extraction"):

```sh
node -e 'const f=require("./fixtures/catalog.synthetic.json");require("fs").writeFileSync("/tmp/live.json",JSON.stringify(f.catalog))'
NOW=$(node -e 'const f=require("./fixtures/catalog.synthetic.json");console.log(new Date(Date.parse(f.provenance.snapshotTimestamp)+3600000).toISOString())')
node bin/check-models-dev-freshness --input /tmp/live.json --now "$NOW"
```

Expected: exit `0`, stderr empty, stdout contains `network not used` and
`freshness: fresh`. Any `fetch` call would fail the run instead of silently
using the network, because the offline branch never reaches `fetchLiveCatalog`.

Stronger proof (what CI does): run the same command with `fetch` replaced by
a throwing stub via a preload module, so even a future code change that added
a network call would explode loudly instead of reaching the network:

```sh
cat > /tmp/block-fetch.mjs <<'EOF'
globalThis.fetch = () => { throw new Error("network access is forbidden in offline probe"); };
EOF
node --import file:///tmp/block-fetch.mjs bin/check-models-dev-freshness \
  --input /tmp/live.json --json --now "$NOW" \
  | grep '"networkUsed": false'
```

Expected: exit `0` and `"networkUsed": false` in the JSON. If any code path
called `fetch`, the probe would exit `1`.

## Hard limits

`--fetch` is the only networked path and is never exercised in tests. Do not
add tests that reach the live network (repo rule, see README Contributing).
If the probe ever needs a second network call site, this doc, its source
scan, and the preload test must be updated together.
