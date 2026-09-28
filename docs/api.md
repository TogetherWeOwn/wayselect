# Wayselect library API reference (`src/index.js`)

> **Dry-run / synthetic estimate.** The library surface is fixture-only: no live
> model calls, no credentials, no network use. Rates are synthetic/list-price
> estimates only — not actual cost or savings. `docs/cli.md` covers the CLI;
> this page covers the programmatic surface re-exported from `src/index.js`.

All examples run from the repo root with Node ≥ 20:

```sh
node --input-type=module -e "import { stableStringify } from './src/index.js'; console.log(stableStringify({ b: 1, a: 2 }));"
# {"a":2,"b":1}
```

Conventions across every export:

- Every success value is `Object.freeze`n (immutable); every failure is
  fail-closed with a named `Error` subclass — never a silent default.
- `catalogInput` is the provider-keyed catalog body (`fixture.catalog` in
  `fixtures/catalog.synthetic.json`); `provenanceInput` is its
  `{ source, snapshotTimestamp, snapshotHash, fetchedAt? }` stamp.
- Candidates are normalized-catalog entries after
  `applySupportConfiguration` (see `support` below).
- `options.now` pins the clock; `evaluationOptions` in `support/helpers.js`
  uses snapshot + 2h with `skipCatalogCheck: true`.

The surface below is exactly the 90 names re-exported by `src/index.js`
(grouped by source module). Helpers that live in a source module but are
*not* re-exported (e.g. `isRouteId`, `nowMs`, `SCHEMA_VERSION`) are
intentionally omitted.

## `catalog.js` — normalize + verify the provider-keyed catalog

### `stableStringify(value)`

Canonical JSON with sorted keys (same input → same bytes, every machine).

```js
import { stableStringify } from "./src/index.js";
console.log(stableStringify({ b: 1, a: 2 }));
// {"a":2,"b":1}
```

### `computeCatalogSnapshotHash(catalogInput)`

SHA-256 over the canonical catalog body; returns `sha256:<64 hex>`.

```js
import { computeCatalogSnapshotHash } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
console.log(computeCatalogSnapshotHash(fx.catalog));
// sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d
```

### `verifyCatalogSnapshotHash(catalogInput, provenanceInput)`

Returns the hash when the body matches `provenance.snapshotHash`;
throws `CatalogValidationError` (malformed shape) or
`CatalogIntegrityError` (tampered body).

```js
import { verifyCatalogSnapshotHash } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
console.log(verifyCatalogSnapshotHash(fx.catalog, fx.provenance));
// sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d
```

### `normalizeCatalog(input, provenanceInput, options?)`

Validates the hash gate, then maps providers → models onto frozen entries
(`routeId`, `providerId`, `modelId`, `catalogOperations`, `capabilities`,
`modalities`, `limits`, `rates`). Unknown fields fail closed.

```js
import { normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
console.log(catalog.entries.length, catalog.entries[0].routeId);
// 6 legacy/old-chat
```

### `CatalogValidationError`

Thrown for malformed catalog/provenance shapes (bad hash form, unknown
field, non-boolean capability).

```js
import { CatalogValidationError, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
try {
  normalizeCatalog(fx.catalog, { ...fx.provenance, snapshotHash: "not-a-hash" });
} catch (error) {
  console.log(error instanceof CatalogValidationError, error.name);
  // true CatalogValidationError
}
```

### `CatalogIntegrityError`

Thrown when the body does not match the claimed `snapshotHash`
(tampered or stale feed).

```js
import { CatalogIntegrityError, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const tampered = structuredClone(fx.catalog);
tampered.northstar.models["alpha-chat"].name = "Evil Chat";
try {
  normalizeCatalog(tampered, fx.provenance);
} catch (error) {
  console.log(error instanceof CatalogIntegrityError, error.name);
  // true CatalogIntegrityError
}
```

## `support.js` — attach support state + evidence to entries

### `SupportState`

Frozen enum of the five support states.

```js
import { SupportState } from "./src/index.js";
console.log(JSON.stringify(SupportState));
// {"CATALOGUED":"catalogued","CONFIGURED":"configured","CONFORMANCE_TESTED":"conformance-tested","UNAVAILABLE":"unavailable","UNSUPPORTED":"unsupported"}
```

### `applySupportConfiguration(catalog, configurationInput)`

Overlays `{ routeId, supportState, operations, evidence }` onto normalized
entries; returns the candidate array used by eligibility/selection.

```js
import { applySupportConfiguration, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const cfg = JSON.parse(readFileSync("fixtures/configuration.synthetic.json", "utf8"));
const candidates = applySupportConfiguration(normalizeCatalog(fx.catalog, fx.provenance), cfg);
console.log(candidates.find((c) => c.routeId === "northstar/alpha-chat").configuredOperations);
// [ 'chat' ]
```

### `SupportConfigurationError`

Thrown for unknown support states, missing routes, or empty operations on
`configured` / `conformance-tested` candidates.

```js
import { SupportConfigurationError, applySupportConfiguration, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
try {
  applySupportConfiguration(catalog, { candidates: [{ routeId: "northstar/alpha-chat", supportState: "superb", operations: ["chat"] }] });
} catch (error) {
  console.log(error instanceof SupportConfigurationError, error.name);
  // true SupportConfigurationError
}
```

## `eligibility.js` — fail-closed candidate evaluation

### `normalizeRequirements(value)`

Freezes the typed-requirements object (`undefined` → `{}`); unknown keys
throw. `false` on a boolean flag means "no constraint".

```js
import { normalizeRequirements } from "./src/index.js";
console.log(JSON.stringify(normalizeRequirements({ toolCalling: true })));
// {"inputModalities":[],"outputModalities":[],"minContextWindow":null,"maxOutputTokens":null,"toolCalling":true,"structuredOutput":false,"reasoning":false}
```

### `normalizeSelectionRequest(request)`

Freezes `{ operation, requiredCapabilities, providerAllowlist,
requirements }`; an empty allowlist throws (fail closed, never match-all).

```js
import { normalizeSelectionRequest } from "./src/index.js";
console.log(JSON.stringify(normalizeSelectionRequest({ operation: "chat", providerAllowlist: ["northstar"] })));
// {"operation":"chat","requiredCapabilities":[],"providerAllowlist":["northstar"],"requirements":{}}
```

### `evaluateEligibility(candidates, requestInput, optionsInput)`

Per-candidate `{ routeId, eligible, reasons, … }`, sorted by route ID.
`optionsInput` requires `{ now, maxEvidenceAgeMs }` plus either
`{ catalog, maxCatalogAgeMs }` or the explicit opt-out
`skipCatalogCheck: true`.

```js
import { applySupportConfiguration, evaluateEligibility, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const cfg = JSON.parse(readFileSync("fixtures/configuration.synthetic.json", "utf8"));
const candidates = applySupportConfiguration(normalizeCatalog(fx.catalog, fx.provenance), cfg);
const out = evaluateEligibility(
  candidates,
  { operation: "chat", requiredCapabilities: ["toolUse"], providerAllowlist: ["northstar", "orbit"] },
  { now: new Date("2026-09-26T16:00:00.000Z"), maxEvidenceAgeMs: 72 * 3600 * 1000, skipCatalogCheck: true },
);
console.log(out.find((e) => e.routeId === "northstar/alpha-chat").eligible);
// true
```

### `EligibilityRequestError`

Thrown for malformed requests/options (empty allowlist, bad clock,
missing catalog without the explicit opt-out).

```js
import { EligibilityRequestError, evaluateEligibility } from "./src/index.js";
try {
  evaluateEligibility([], { operation: "chat", providerAllowlist: [] }, { now: new Date(), maxEvidenceAgeMs: 1, skipCatalogCheck: true });
} catch (error) {
  console.log(error instanceof EligibilityRequestError, error.name);
  // true EligibilityRequestError
}
```

## `ingest.js` — models.dev-shaped JSON → catalog input

### `DEFAULT_MODELS_DEV_SOURCE`

Default fetch URL for the opt-in `--fetch` path.

```js
import { DEFAULT_MODELS_DEV_SOURCE } from "./src/index.js";
console.log(DEFAULT_MODELS_DEV_SOURCE);
// https://models.dev/api.json
```

### `hashSnapshot(value)`

Canonical-body hash (`sha256:<hex>`) for any JSON value.

```js
import { hashSnapshot } from "./src/index.js";
console.log(hashSnapshot({ a: 1 }));
// sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862
```

### `hashRawText(text)`

SHA-256 over raw UTF-8 text (non-strings throw).

```js
import { hashRawText } from "./src/index.js";
console.log(hashRawText("hi"));
// sha256:8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4
```

### `ingestModelsDev(input, options)`

Maps provider-keyed models.dev data onto `{ catalog, provenance,
quarantined }`. Every kept entry lands `catalogued`-only; unknown fields
quarantine with reasons. `options` requires `source` (non-empty string);
`snapshotTimestamp` defaults to now, `snapshotHash` defaults to the
canonical body hash.

```js
import { ingestModelsDev } from "./src/index.js";
const out = ingestModelsDev(
  { northstar: { id: "northstar", name: "Northstar", models: { "alpha-chat": { id: "alpha-chat", name: "Alpha Chat", modalities: { input: ["text"], output: ["text"] }, tool_call: true, cost: { input: 1, output: 2 } } } } },
  { source: "synthetic://wayselect/doc-example", snapshotTimestamp: "2026-09-24T10:00:00.000Z" },
);
console.log(Object.keys(out.catalog.northstar.models), out.quarantined.length);
// [ 'alpha-chat' ] 0
```

### `IngestError`

Thrown for non-object input, empty providers, bad `options`, or a
mismatched explicit `snapshotHash`.

```js
import { IngestError, ingestModelsDev } from "./src/index.js";
try {
  ingestModelsDev({}, { source: "synthetic://wayselect/doc-example" });
} catch (error) {
  console.log(error instanceof IngestError, error.name);
  // true IngestError
}
```

## `selection.js` — cheapest eligible route wins

### `selectRoute(candidates, requestInput, options)`

`{ status: "selected" | "no-eligible-route", dryRun: true, policy,
rateDisclaimer, request, selected, candidates }`. Eligible candidates sort
lowest synthetic rate first, then lexicographic route ID.

```js
import { applySupportConfiguration, normalizeCatalog, selectRoute } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const cfg = JSON.parse(readFileSync("fixtures/configuration.synthetic.json", "utf8"));
const candidates = applySupportConfiguration(normalizeCatalog(fx.catalog, fx.provenance), cfg);
const verdict = selectRoute(
  candidates,
  { operation: "chat", requiredCapabilities: ["toolUse"], providerAllowlist: ["northstar", "orbit"] },
  { now: new Date("2026-09-26T16:00:00.000Z"), maxEvidenceAgeMs: 72 * 3600 * 1000, skipCatalogCheck: true },
);
console.log(verdict.status, verdict.selected.routeId);
// selected northstar/alpha-chat
```

## `validate-cli-json.js` — verify `--json` payloads

### `validateCliJson(payload)`

`{ ok: true }` for schema-valid select/explain/catalog-import payloads
(including cross-field rank/eligibility invariants), else
`{ ok: false, error }`.

```js
import { validateCliJson } from "./src/index.js";
console.log(JSON.stringify(validateCliJson({ nope: 1 })).slice(0, 60));
// {"ok":false,"error":"CLI --json payload rejected [v1]: / mus
```

A real `bin/wayselect select … --json` body validates `{ ok: true }`
(verified against live CLI output; see `docs/cli-json-contract.md` for the
v1 schema).

## `routeIds.js` — deterministic tie-break order

### `compareRouteIds(left, right)`

UTF-16 code-unit comparison (`-1` / `0` / `1`) — locale-independent.

```js
import { compareRouteIds } from "./src/index.js";
console.log(compareRouteIds("a/b", "a/c"), ["b/b", "a/b"].sort(compareRouteIds));
// -1 [ 'a/b', 'b/b' ]
```

## `gateway.js` — offline OpenAI-compatible chat surface

### `handleChatCompletionsRequest(input)`

Async in-process handler (FakeTransport-backed, `networkUsed: false`
enforced). Input: `{ headers, body, gatewayKey, candidates,
eligibilityOptions, transport? }`. Returns `{ httpStatus, body }` with an
OpenAI `chat.completion` shape plus the `wayselect` extension on 200, or
an `{ httpStatus, body: { error } }` envelope on 400/401/500. Malformed
wiring throws `TypeError`; request-level problems return errors.

```js
import { applySupportConfiguration, handleChatCompletionsRequest, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const cfg = JSON.parse(readFileSync("fixtures/configuration.synthetic.json", "utf8"));
const candidates = applySupportConfiguration(normalizeCatalog(fx.catalog, fx.provenance), cfg);
const result = await handleChatCompletionsRequest({
  headers: { authorization: "Bearer k" },
  body: { model: "auto", messages: [{ role: "user", content: "Say hello." }] },
  gatewayKey: "k",
  candidates,
  eligibilityOptions: { now: new Date("2026-09-26T16:00:00.000Z"), maxEvidenceAgeMs: 72 * 3600 * 1000, skipCatalogCheck: true },
});
console.log(result.httpStatus, result.body.model, result.body.wayselect.selectedRouteId);
// 200 northstar/unknown-tools northstar/unknown-tools
```

> With no requirements every candidate with fresh evidence is eligible, so
> the cheapest synthetic rate wins (`unknown-tools`). Pinning
> `model: "northstar/alpha-chat"` serves that route when eligible, or 400s
> when it is not — never silently substituted.

## `purchase.js` — buyer purchase-intake validation

### `validatePurchaseSubmission(submission, options?)`

Returns frozen `{ routeId, providerId, modelId, buyerId, provenance }`;
`provenance.source` must be `synthetic://…`. Failures throw
`PurchaseSubmissionError` with `{ code, key }`.

```js
import { validatePurchaseSubmission } from "./src/index.js";
import { readFileSync } from "node:fs";
const { valid } = JSON.parse(readFileSync("fixtures/purchase.synthetic.json", "utf8"));
console.log(validatePurchaseSubmission(valid).routeId);
// northstar/alpha-chat
```

### `PurchaseSubmissionError`

Carries machine-readable `{ code, key, source }` for intake failures.

```js
import { PurchaseSubmissionError, validatePurchaseSubmission } from "./src/index.js";
try {
  validatePurchaseSubmission({ providerId: "northstar", modelId: "alpha-chat", buyerId: "b", confirm: true });
} catch (error) {
  console.log(error instanceof PurchaseSubmissionError, error.code, error.key);
  // true missing-provenance provenance
}
```

## `sellerSubmission.js` — seller listing-intake validation

### `validateSellerSubmission(submission, options?)`

Returns frozen `{ routeId, providerId, modelId, entry, provenance }`;
`modelId` must equal `entry.id` (SG2). Failures throw
`SellerSubmissionError` with `{ code, key }`.

```js
import { validateSellerSubmission } from "./src/index.js";
import { readFileSync } from "node:fs";
const { valid } = JSON.parse(readFileSync("fixtures/seller-submission.synthetic.json", "utf8"));
console.log(validateSellerSubmission(valid).routeId);
// northstar/seller-chat
```

### `SellerSubmissionError`

Carries machine-readable `{ code, key, source }` for intake failures.

```js
import { SellerSubmissionError, validateSellerSubmission } from "./src/index.js";
import { readFileSync } from "node:fs";
const { valid } = JSON.parse(readFileSync("fixtures/seller-submission.synthetic.json", "utf8"));
try {
  validateSellerSubmission({ ...valid, modelId: "other-chat" });
} catch (error) {
  console.log(error instanceof SellerSubmissionError, error.code);
  // true id-mismatch
}
```

## `intakeLimits.js` — intake caps and identifier rules

### `MAX_PROVIDER_ID_LENGTH`

```js
import { MAX_PROVIDER_ID_LENGTH } from "./src/index.js";
console.log(MAX_PROVIDER_ID_LENGTH);
// 64
```

### `MAX_MODEL_ID_LENGTH`

```js
import { MAX_MODEL_ID_LENGTH } from "./src/index.js";
console.log(MAX_MODEL_ID_LENGTH);
// 64
```

### `MAX_BUYER_ID_LENGTH`

```js
import { MAX_BUYER_ID_LENGTH } from "./src/index.js";
console.log(MAX_BUYER_ID_LENGTH);
// 120
```

### `MAX_DESCRIPTION_LENGTH`

```js
import { MAX_DESCRIPTION_LENGTH } from "./src/index.js";
console.log(MAX_DESCRIPTION_LENGTH);
// 4000
```

### `MAX_ETAG_LENGTH`

```js
import { MAX_ETAG_LENGTH } from "./src/index.js";
console.log(MAX_ETAG_LENGTH);
// 256
```

### `MAX_IDEMPOTENCY_KEY_LENGTH`

Cap for the optional client-generated purchase idempotency token
(UUID recommended; sent as the `Idempotency-Key` header on the preview
purchase route, validated in `src/purchase.js`).

```js
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "./src/index.js";
console.log(MAX_IDEMPOTENCY_KEY_LENGTH);
// 256
```

### `MAX_JSON_BODY_BYTES`

Body cap for POST routes (~64 KB, enforced in `web/jsonBody.js`).

```js
import { MAX_JSON_BODY_BYTES } from "./src/index.js";
console.log(MAX_JSON_BODY_BYTES);
// 65536
```

### `MAX_JSON_BODY_READ_MS`

Read deadline for one streamed POST body (stalled senders fail closed).

```js
import { MAX_JSON_BODY_READ_MS } from "./src/index.js";
console.log(MAX_JSON_BODY_READ_MS);
// 10000
```

### `MAX_GATEWAY_MESSAGES`

At most 32 messages per chat-completions request (fail-closed 400).

```js
import { MAX_GATEWAY_MESSAGES } from "./src/index.js";
console.log(MAX_GATEWAY_MESSAGES);
// 32
```

### `MAX_GATEWAY_MESSAGE_CHARS`

At most 16k chars of normalized text per message.

```js
import { MAX_GATEWAY_MESSAGE_CHARS } from "./src/index.js";
console.log(MAX_GATEWAY_MESSAGE_CHARS);
// 16000
```

### `MAX_GATEWAY_TOTAL_CHARS`

At most 64k chars combined across messages.

```js
import { MAX_GATEWAY_TOTAL_CHARS } from "./src/index.js";
console.log(MAX_GATEWAY_TOTAL_CHARS);
// 64000
```

### `ROUTE_ID_PATTERN`

Lowercase slug ids (`providerId`/`modelId` segments).

```js
import { ROUTE_ID_PATTERN } from "./src/index.js";
console.log(ROUTE_ID_PATTERN.test("northstar/alpha-chat"), ROUTE_ID_PATTERN.test("northstar"), ROUTE_ID_PATTERN.test("Bad_ID"));
// false true false
```

> `ROUTE_ID_PATTERN` matches one id *segment* (`/^[a-z0-9][a-z0-9-]{0,63}$/`),
> so a full `provider/model` route ID never matches whole — test each
> segment separately.

### `SYNTHETIC_SOURCE_PREFIX`

Staging-only intake boundary: only `synthetic://` sources are accepted.

```js
import { SYNTHETIC_SOURCE_PREFIX } from "./src/index.js";
console.log(SYNTHETIC_SOURCE_PREFIX);
// synthetic://
```

## `transport.js` — offline execution stub

### `FakeTransport`

Records `{ routeId, payload }` calls (via the `.calls` getter) and returns
`{ adapter: "fake", networkUsed: false, routeId, output: { text } }`.
Rejects routes carrying executable location fields (`url`, `endpoint`,
`baseUrl`, `apiUrl`).

```js
import { FakeTransport } from "./src/index.js";
const transport = new FakeTransport();
const result = await transport.send({ route: { routeId: "northstar/alpha-chat" }, payload: { prompt: "hi" } });
console.log(result.adapter, result.networkUsed, result.output.text, transport.calls.length);
// fake false Synthetic response from northstar/alpha-chat 1
```

## `freshness.js` — catalog snapshot currency

### `checkCatalogFreshness(catalog, options)`

`{ fresh, ageMs, snapshotTimestamp, maxCatalogAgeMs }`; `ageMs < 0` means a
future-dated snapshot. Malformed clocks throw `CatalogFreshnessError`.

```js
import { checkCatalogFreshness, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
console.log(checkCatalogFreshness(catalog, { now: new Date("2026-09-26T16:00:00.000Z"), maxCatalogAgeMs: 24 * 3600 * 1000 }).fresh);
// true
```

### `requireFreshCatalog(catalog, options)`

Returns the probe when fresh; throws `CatalogStaleError` (with
`{ ageMs, maxCatalogAgeMs, snapshotTimestamp }`) when stale or future.

```js
import { requireFreshCatalog, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
console.log(requireFreshCatalog(catalog, { now: new Date("2026-09-26T16:00:00.000Z"), maxCatalogAgeMs: 24 * 3600 * 1000 }).fresh);
// true
```

### `CatalogFreshnessError`

Thrown for unparseable snapshot timestamps or invalid `now` / limit
options.

```js
import { CatalogFreshnessError, checkCatalogFreshness } from "./src/index.js";
try {
  checkCatalogFreshness({ provenance: { snapshotTimestamp: "not-a-date" } }, { now: new Date(), maxCatalogAgeMs: 1 });
} catch (error) {
  console.log(error instanceof CatalogFreshnessError, error.name);
  // true CatalogFreshnessError
}
```

### `CatalogStaleError`

Carries `{ ageMs, maxCatalogAgeMs, snapshotTimestamp }` for stale/future
snapshots.

```js
import { CatalogStaleError, requireFreshCatalog, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
try {
  requireFreshCatalog(catalog, { now: new Date("2026-10-26T16:00:00.000Z"), maxCatalogAgeMs: 24 * 3600 * 1000 });
} catch (error) {
  console.log(error instanceof CatalogStaleError, error.name, typeof error.ageMs);
  // true CatalogStaleError number
}
```

## `snapshot.js` — staging-only snapshot builds

### `DEFAULT_STAGING_SOURCE_PREFIX`

```js
import { DEFAULT_STAGING_SOURCE_PREFIX } from "./src/index.js";
console.log(DEFAULT_STAGING_SOURCE_PREFIX);
// synthetic://
```

### `KNOWN_CAPABILITY_NAMES`

Capabilities audited for gaps.

```js
import { KNOWN_CAPABILITY_NAMES } from "./src/index.js";
console.log(JSON.stringify(KNOWN_CAPABILITY_NAMES));
// ["attachment","reasoning","toolUse","structuredOutput"]
```

### `computeContentHash(entries)`

SHA-256 over the canonical, route-sorted snapshot entries.

```js
import { buildSnapshot, computeContentHash } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(computeContentHash(snapshot.entries) === snapshot.contentHash);
// true
```

### `findEntryGaps(entry)`

Per-entry `{ routeId, gap }` list (`missing-capability:*`,
`missing-rates`, `no-catalogued-operations`).

```js
import { buildSnapshot, findEntryGaps } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(findEntryGaps(snapshot.entries.find((e) => e.routeId === "northstar/unknown-tools")).map((g) => g.gap).join(", "));
// missing-capability:attachment, missing-capability:reasoning, missing-capability:toolUse, missing-capability:structuredOutput
```

### `buildSnapshot(catalogInput, provenanceInput, options?)`

Frozen `{ tool: "wayselect-snapshot", mode: "staging-only", …,
contentHash, declaredHashVerified, freshness, gaps, entries }`. Refuses
non-`synthetic://` sources; `options.now` pins `collectedAt`.

```js
import { buildSnapshot } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(snapshot.tool, snapshot.entries.length, snapshot.declaredHashVerified);
// wayselect-snapshot 6 false
```

> `declaredHashVerified` is `false` for the checked-in fixture because the
> fixture stamp is the *catalog-body* hash while `contentHash` is over the
> *canonical snapshot entries* — different domains. The snapshot records a
> `declared-hash-unverified` gap for it; `auditIngestionSnapshot` below
> still reports `ok: true` (the placeholder is recorded, not gated).

### `snapshotIsClean(snapshot)`

`true` only when `snapshot.gaps` is empty (throws on malformed input).

```js
import { buildSnapshot, snapshotIsClean } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
console.log(snapshotIsClean(buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" })));
// false
```

### `SnapshotError`

Thrown for malformed snapshots, entries, or options.

```js
import { SnapshotError, computeContentHash } from "./src/index.js";
try {
  computeContentHash("not-an-array");
} catch (error) {
  console.log(error instanceof SnapshotError, error.name);
  // true SnapshotError
}
```

## `provenanceAudit.js` — backfill provenance gate

### `DEFAULT_BACKFILL_MAX_AGE_MS`

```js
import { DEFAULT_BACKFILL_MAX_AGE_MS } from "./src/index.js";
console.log(DEFAULT_BACKFILL_MAX_AGE_MS);
// 86400000
```

### `EXPECTED_BACKFILL_TOOL`

```js
import { EXPECTED_BACKFILL_TOOL } from "./src/index.js";
console.log(EXPECTED_BACKFILL_TOOL);
// wayselect-snapshot
```

### `EXPECTED_BACKFILL_MODE`

```js
import { EXPECTED_BACKFILL_MODE } from "./src/index.js";
console.log(EXPECTED_BACKFILL_MODE);
// staging-only
```

### `EXPECTED_BACKFILL_SOURCE_PREFIX`

```js
import { EXPECTED_BACKFILL_SOURCE_PREFIX } from "./src/index.js";
console.log(EXPECTED_BACKFILL_SOURCE_PREFIX);
// synthetic://
```

### `auditIngestionSnapshot(snapshot, options?)`

Frozen `{ filename, ok, failures, entryCount, contentHash,
contentHashVerified, declaredHashVerified, provenance, freshness }`;
`ok` is true only with zero failures. Freshness defaults to evaluating at
`collectedAt` (deterministic); pass `options.now` for a reference time.

```js
import { auditIngestionSnapshot, buildSnapshot } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(auditIngestionSnapshot(snapshot).ok);
// true
```

### `ProvenanceAuditError`

Thrown for malformed snapshots or options (failures themselves are
*returned* in `failures`, not thrown).

```js
import { ProvenanceAuditError, auditIngestionSnapshot } from "./src/index.js";
try {
  auditIngestionSnapshot(null);
} catch (error) {
  console.log(error instanceof ProvenanceAuditError, error.name);
  // true ProvenanceAuditError
}
```

## `catalogDiff.js` — snapshot-to-snapshot diffs

### `compareEntries(previous, current)`

`{ changed, fields: { name, operations, capabilities, rates } }` — only
the display name flips the top-level `changed`; other dimensions are
compared field-by-field.

```js
import { buildSnapshot, compareEntries } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(JSON.stringify(compareEntries(snapshot.entries[0], snapshot.entries[0]).changed));
// false
```

### `diffSnapshots(previousInput, currentInput)`

Frozen `{ added, removed, changed, unchanged, newGaps, resolvedGaps,
currentGaps, summary, … }`; refuses differing `sourcePrefix` values.

```js
import { buildSnapshot, diffSnapshots } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(diffSnapshots(snapshot, snapshot).summary.unchangedCount);
// 6
```

### `formatDiffReport(diffInput)`

Markdown report (lists sampled, counts always exact).

```js
import { buildSnapshot, diffSnapshots, formatDiffReport } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const snapshot = buildSnapshot(fx.catalog, fx.provenance, { now: "2026-09-26T16:00:00.000Z" });
console.log(formatDiffReport(diffSnapshots(snapshot, snapshot)).split("\n")[0]);
// # Wayselect staging catalog snapshot diff
```

### `SnapshotDiffError`

Thrown for malformed entries/snapshots or cross-prefix diffs.

```js
import { SnapshotDiffError, compareEntries } from "./src/index.js";
try {
  compareEntries(null, null);
} catch (error) {
  console.log(error instanceof SnapshotDiffError, error.name);
  // true SnapshotDiffError
}
```

## `searchIndex.js` — fixture-only search index

### `SEARCH_INDEX_TOOL`

```js
import { SEARCH_INDEX_TOOL } from "./src/index.js";
console.log(SEARCH_INDEX_TOOL);
// wayselect-search-index
```

### `SEARCH_INDEX_MODE`

```js
import { SEARCH_INDEX_MODE } from "./src/index.js";
console.log(SEARCH_INDEX_MODE);
// fixture-only
```

### `DEFAULT_SEARCH_INDEX_SOURCE_PREFIX`

```js
import { DEFAULT_SEARCH_INDEX_SOURCE_PREFIX } from "./src/index.js";
console.log(DEFAULT_SEARCH_INDEX_SOURCE_PREFIX);
// synthetic://
```

### `buildSearchIndex(catalogInput, provenanceInput, options?)`

Frozen `{ tool, mode, sourcePrefix, collectedAt, provenance,
contentHash, freshness, entries }`; refuses non-`synthetic://` sources.

```js
import { buildSearchIndex } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
console.log(buildSearchIndex(fx.catalog, fx.provenance).entries.length);
// 6
```

### `reloadSearchIndex(previousIndex, catalogInput, provenanceInput, options?)`

Rebuilds and reports `{ changed, index, previousContentHash,
contentHash }`.

```js
import { buildSearchIndex, reloadSearchIndex } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const first = buildSearchIndex(fx.catalog, fx.provenance);
console.log(reloadSearchIndex(first, fx.catalog, fx.provenance).changed);
// false
```

### `createRefreshQueue(seed?)`

Deduping refresh queue keyed by body-hash + provenance stamp:
`enqueue(…)` → job (repeat enqueues return `{ …, deduped: true }`),
`drain()` → per-job `{ jobId, changed, previousContentHash,
contentHash, routeCount }`, plus `pendingCount()` / `currentIndex()`.

```js
import { createRefreshQueue } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const queue = createRefreshQueue();
console.log(queue.enqueue(fx.catalog, fx.provenance).jobId, queue.pendingCount(), queue.drain().length);
// refresh-1 1 1
```

### `probeSearchIndexRefresh(catalogInput, provenanceInput, options?)`

Done-criteria probe: `{ ok, contentHash, checks }` over the R1–R5
checks (currency only when `options.maxCatalogAgeMs` is set).

```js
import { probeSearchIndexRefresh } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const probe = probeSearchIndexRefresh(fx.catalog, fx.provenance);
console.log(probe.ok, JSON.stringify(probe.checks.map((c) => c.id)));
// true ["R1-source","R2-parity","R3-stable","R4-idempotent","R5-fresh"]
```

### `SearchIndexError`

Thrown for malformed indexes, options, seeds, or non-staging sources.

```js
import { SearchIndexError, buildSearchIndex } from "./src/index.js";
try {
  buildSearchIndex({}, { source: "https://example.invalid/catalog" });
} catch (error) {
  console.log(error instanceof SearchIndexError, error.name);
  // true SearchIndexError
}
```

## `cliErrors.js` — exact CLI error strings

### `missingValueMessage(flag)`

```js
import { missingValueMessage } from "./src/index.js";
console.log(missingValueMessage("--operation"));
// Missing value for --operation
```

### `unknownArgumentMessage(flag)`

```js
import { unknownArgumentMessage } from "./src/index.js";
console.log(unknownArgumentMessage("--nope"));
// Unknown argument: --nope
```

### `invalidMaxCatalogAgeMessage()`

```js
import { invalidMaxCatalogAgeMessage } from "./src/index.js";
console.log(invalidMaxCatalogAgeMessage());
// --max-catalog-age-hours must be a non-negative number
```

### `staleSnapshotMessage(ageMs, maxCatalogAgeMs)`

```js
import { staleSnapshotMessage } from "./src/index.js";
console.log(staleSnapshotMessage(1000, 500));
// refusing stale staging snapshot: age 1000ms exceeds limit 500ms
```

### `futureSnapshotMessage(ageMs, maxCatalogAgeMs)`

```js
import { futureSnapshotMessage } from "./src/index.js";
console.log(futureSnapshotMessage(-5, 500));
// refusing future-dated staging snapshot: age -5ms exceeds limit 500ms
```

### `failOnGapsMessage(gapCount)`

```js
import { failOnGapsMessage } from "./src/index.js";
console.log(failOnGapsMessage(3));
// snapshot reports 3 provenance gap(s); failing on --fail-on-gaps
```

### `invalidKeepLastMessage()`

```js
import { invalidKeepLastMessage } from "./src/index.js";
console.log(invalidKeepLastMessage());
// --keep-last must be a positive integer
```

### `invalidPruneMaxAgeDaysMessage()`

```js
import { invalidPruneMaxAgeDaysMessage } from "./src/index.js";
console.log(invalidPruneMaxAgeDaysMessage());
// --max-age-days must be a non-negative number
```

### `invalidPruneDirMessage()`

```js
import { invalidPruneDirMessage } from "./src/index.js";
console.log(invalidPruneDirMessage());
// --dir must not contain .. segments
```

### `invalidPruneNowMessage()`

```js
import { invalidPruneNowMessage } from "./src/index.js";
console.log(invalidPruneNowMessage());
// --now must be a valid ISO timestamp
```

### `formatCliFailure(error)`

```js
import { formatCliFailure } from "./src/index.js";
console.log(JSON.stringify(formatCliFailure(new Error("boom"))));
// "Error: boom\n"
```

## `snapshotPrune.js` — snapshot-retention planning

### `DEFAULT_KEEP_LAST`

```js
import { DEFAULT_KEEP_LAST } from "./src/index.js";
console.log(DEFAULT_KEEP_LAST);
// 10
```

### `DEFAULT_MAX_AGE_DAYS`

```js
import { DEFAULT_MAX_AGE_DAYS } from "./src/index.js";
console.log(DEFAULT_MAX_AGE_DAYS);
// 30
```

### `SNAPSHOT_FILE_PATTERN`

Only `snapshot-*.json` names are prune candidates; everything else is
`skipped`, never deleted.

```js
import { SNAPSHOT_FILE_PATTERN } from "./src/index.js";
console.log(SNAPSHOT_FILE_PATTERN.test("snapshot-x.json"), SNAPSHOT_FILE_PATTERN.test("notes.txt"));
// true false
```

### `planSnapshotPrune(files, options?)`

Plans over `{ name, mtimeMs }` listings → frozen `{ kept, pruned,
skipped }`. The keep-last floor always survives; only old overflow is
pruned. `options.now` pins the clock.

```js
import { planSnapshotPrune } from "./src/index.js";
console.log(JSON.stringify(planSnapshotPrune(
  [{ name: "snapshot-a.json", mtimeMs: 1 }, { name: "notes.txt", mtimeMs: 1 }],
  { keepLast: 1, maxAgeDays: 30, now: "2026-09-26T16:00:00.000Z" },
)));
// {"kept":["snapshot-a.json"],"pruned":[],"skipped":["notes.txt"]}
```

### `SnapshotPruneError`

Thrown for malformed listings or options.

```js
import { SnapshotPruneError, planSnapshotPrune } from "./src/index.js";
try {
  planSnapshotPrune([], { keepLast: 0 });
} catch (error) {
  console.log(error instanceof SnapshotPruneError, error.name);
  // true SnapshotPruneError
}
```

## `modelsDevProbe.js` — fixture-vs-live freshness probe

### `extractLiveRoutes(input)`

Parses provider-keyed live models.dev data → `{ routes: Map<routeId,
record>, quarantined, providerCount }`; malformed entries quarantine,
never throw (empty input throws).

```js
import { extractLiveRoutes } from "./src/index.js";
const live = extractLiveRoutes({ northstar: { id: "northstar", name: "N", models: { "alpha-chat": { id: "alpha-chat", name: "Alpha Chat", modalities: { input: ["text"], output: ["text"] }, tool_call: true, cost: { input: 1, output: 2 } } } } });
console.log(live.routes.size, live.providerCount, live.quarantined.length);
// 1 1 0
```

### `fixtureRouteRecord(entry)`

Comparable record mapping a normalized fixture entry onto live field
names (`toolUse` → `toolCall`, `rates` → `cost`).

```js
import { fixtureRouteRecord, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const entry = normalizeCatalog(fx.catalog, fx.provenance).entries.find((e) => e.routeId === "northstar/alpha-chat");
console.log(fixtureRouteRecord(entry).routeId, fixtureRouteRecord(entry).toolCall);
// northstar/alpha-chat true
```

### `diffProbedRoutes(fixtureEntries, liveRoutes)`

Frozen `{ added, removed, changed, unchanged, summary }`; `changed`
entries carry per-field flags over `name, attachment, reasoning,
toolCall, structuredOutput, cost`.

```js
import { diffProbedRoutes, extractLiveRoutes, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const entries = normalizeCatalog(fx.catalog, fx.provenance).entries;
const live = extractLiveRoutes({ northstar: { id: "northstar", name: "N", models: { "alpha-chat": { id: "alpha-chat", name: "Alpha Chat", modalities: { input: ["text"], output: ["text"] }, tool_call: true, cost: { input: 1, output: 2 } } } } });
console.log(JSON.stringify(diffProbedRoutes(entries, live.routes).summary));
// {"fixtureCount":6,"liveCount":1,"addedCount":0,"removedCount":5,"changedCount":1,"unchangedCount":0}
```

### `compareProbeProvenance(fixtureProvenance, liveProvenance)`

`{ changed, fields: { source, timestamp, hash } }` — fixture pin vs
live fetch stamp, field-by-field.

```js
import { compareProbeProvenance } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const out = compareProbeProvenance(fx.provenance, { source: "https://models.dev/api.json", fetchedAt: "2026-09-26T16:00:00.000Z", rawHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" });
console.log(out.changed);
// true
```

### `formatProbeReport(args)`

Markdown report (route lists sampled at 50, counts always exact).
Required: `fetchedAt, fetchSource, rawHash, fetchDurationMs,
networkUsed, fixtureProvenance, fixtureCount, liveProviderCount,
liveCount, quarantined, freshness, provenance, diff`.

```js
import { checkCatalogFreshness, compareProbeProvenance, diffProbedRoutes, extractLiveRoutes, formatProbeReport, normalizeCatalog } from "./src/index.js";
import { readFileSync } from "node:fs";
const fx = JSON.parse(readFileSync("fixtures/catalog.synthetic.json", "utf8"));
const catalog = normalizeCatalog(fx.catalog, fx.provenance);
const live = extractLiveRoutes({ northstar: { id: "northstar", name: "N", models: { "alpha-chat": { id: "alpha-chat", name: "Alpha Chat", modalities: { input: ["text"], output: ["text"] }, tool_call: true, cost: { input: 1, output: 2 } } } } });
const report = formatProbeReport({
  fetchedAt: "2026-09-26T16:00:00.000Z", fetchSource: "offline-fixture", rawHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  fetchDurationMs: 5, networkUsed: false, fixtureProvenance: fx.provenance, fixtureCount: catalog.entries.length,
  liveProviderCount: live.providerCount, liveCount: live.routes.size, quarantined: [...live.quarantined],
  freshness: checkCatalogFreshness(catalog, { now: new Date("2026-09-26T16:00:00.000Z"), maxCatalogAgeMs: 24 * 3600 * 1000 }),
  provenance: compareProbeProvenance(fx.provenance, { source: "offline-fixture", fetchedAt: "2026-09-26T16:00:00.000Z", rawHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }),
  diff: diffProbedRoutes(catalog.entries, live.routes),
});
console.log(report.split("\n")[0]);
// # models.dev catalog freshness probe (TOG-5551)
```
