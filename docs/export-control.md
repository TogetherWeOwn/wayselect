# Export-control note

Wayselect is published as publicly available open-source software under the
MIT License (see [`LICENSE`](../LICENSE), `package.json` `"license": "MIT"`).
This note is informational, not legal advice; if your use case is
export-sensitive, consult counsel.

## What the code contains

- **No encryption functionality.** The only uses of `node:crypto` in shipped
  code are SHA-256 content hashes for catalog/snapshot provenance
  (`src/catalog.js`, `src/ingest.js`, `src/snapshot.js`,
  `bin/refresh-catalog-fixtures`, `bin/check-models-dev-freshness`,
  `bin/accept-fixture-refresh`, `bin/eval-wayselect-search-prompts`) and
  random nonces for temp-file names, smoke-test bearer keys, and synthetic
  response IDs (`src/atomicWrite.js`, `src/gateway.js`,
  `support/gateway-smoke-probes.js`). There is no cipher, TLS implementation,
  key exchange, or encrypted transport anywhere in the repo — the only
  `node:tls` reference is the test-suite no-network guard
  (`support/no-network-guard.js`), which intercepts socket creation so tests
  stay offline.
- **No controlled technology.** The slice is a fixture-only, dry-run model
  selector over synthetic catalog data: no live routing, no model calls, no
  credentials, no endpoint discovery (see `README.md`
  "What Wayselect is / is not").

## Why this note exists

Open-source publication (priority order: [TOG-4025](/TOG/issues/TOG-4025))
requires stating the export position up front: to our knowledge there is
nothing in this repository subject to export licensing, and public
availability under an OSI-approved license is the basis for that position.
If a future slice adds real cryptography, networked transport, or
controlled capability data, this note must be revisited in the same PR.
