# Wayselect

> **Early development — fixture-only, dry-run only.** No live routing, no live model calls, no credentials, no endpoint discovery, no network use. Makes no compatibility, cost, or savings claims. Catalog presence (`catalogued`) is not support, permission, configuration, conformance, or availability.

Wayselect is a small Node 20+ ES module library with a thin local CLI. It turns a newly authored synthetic, models.dev-shaped catalog fixture into an explicit support configuration, applies fail-closed eligibility rules, and returns an inspectable selection explanation. The only transport in this slice is an in-memory fake adapter.

## What Wayselect is / is not

Is:

- A dry-run selector over a synthetic fixture catalog: normalize, configure explicit support states, apply fail-closed eligibility, and explain the deterministic pick.
- A local teaching and review surface — every decision ships its candidate reasons, provenance, and synthetic-rate policy.

Is not:

- A transport gateway: it never routes a request to a live model, never discovers endpoints, and never sends traffic over the network (`FakeTransport` reports `networkUsed: false`).
- A compatibility, cost, or savings oracle: selected rates are synthetic/list-price estimates only, and catalog presence never implies permission, configuration, conformance, or availability.

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

Quickstart from a clean checkout:

```sh
git clone https://github.com/TogetherWeOwn/wayselect && cd wayselect
node --version   # 20+
npm test
npm run demo
```

Full CLI reference (copy-pasteable `select`/`explain` examples, `--json`, exit codes 0/1/2/3): see `docs/cli.md`.

The demo (`wayselect select`) reads only:

- `fixtures/catalog.synthetic.json`
- `fixtures/configuration.synthetic.json`
- `fixtures/request.synthetic.json`

It prints:

1. the deterministic selected route or `no eligible route`, labelled dry-run;
2. the ranked candidates with eligibility or exclusion reasons;
3. fixture provenance.

Use alternate fixture files without adding code or network access:

```sh
node bin/wayselect select \
  --catalog fixtures/catalog.synthetic.json \
  --configuration fixtures/configuration.synthetic.json \
  --request fixtures/request.synthetic.json
```

Use `wayselect select --json` or `wayselect explain` for the machine-readable
shape and per-candidate detail. See `docs/cli.md` for copy-pasteable examples,
including exit codes (0 selected, 1 invalid input, 2 usage error,
3 no eligible route).

## Library boundaries

- `src/catalog.js` validates a narrow provider-keyed, models.dev-shaped fixture subset and preserves provenance. Unknown fields are rejected at the boundary.
- `src/support.js` applies explicit support states and configured operation claims without mutating catalog evidence.
- `src/eligibility.js` applies operation, capability, provider, and evidence-age rules. An empty provider allowlist is invalid.
- `src/selection.js` produces a dry-run decision and full candidate explanations.
- `src/transport.js` exposes only `FakeTransport`; executable location fields are rejected.
- `bin/wayselect` is the thin CLI (`select`/`explain`, `--help`, `--version`); see `docs/cli.md`.

The normalized capability names are `attachment`, `reasoning`, `toolUse`, `structuredOutput`, `imageInput`, `textInput`, and `textOutput`. A required name not present in normalized data is reported as `missing-capability:<name>` and is never guessed.

## Explicit non-goals

This slice does not include live provider calls, endpoint discovery, credentials, HTTP servers, paid inference, real usage or billing data, third-party catalog redistribution, production deployment, universal compatibility, or a savings claim. Future transport or live-conformance work requires separate provenance, security, access, and review decisions.

## Contributing

- Tests stay no-network: `npm test` runs `node --test` with stdlib-only imports, and the transport test fails if `fetch` is called. Do not add tests that fetch, listen, or dial out.
- Fixture policy: fixtures under `fixtures/` are synthetic and checked in. Add or edit them as data files; keep unknown fields rejected at the `src/catalog.js` boundary and never guess missing capability data.
- Node 20+ ESM, standard library only; keep `bin/wayselect` thin and `src/` boundaries intact. No new runtime dependencies without a CTO note.
- Keep README claims accurate to merged behavior only — no compatibility, cost, or savings language.

License: not yet chosen.
