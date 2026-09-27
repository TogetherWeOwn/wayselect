# Eligibility reason glossary (TOG-5750)

Operator lookup for every reason code the Wayselect eligibility evaluator can
emit. Emission source of truth: `evaluateEligibility` in `src/eligibility.js`.
Display source of truth: `classifyEligibilityDisplay` in `web/eligibility.js`,
which maps each verdict to one of three states: Granted / Blocked / Unknown.

No reason code ever renders **Granted**: Granted means `eligible: true` with
zero reasons. Every code below therefore maps to **Blocked** ("we know it is
excluded") or **Unknown** ("we do not know" — fail-closed, not selectable
until the underlying data is fixed).

## Evaluation order (why some reasons never co-occur)

1. **Catalog gate first, short-circuiting.** When the catalog freshness probe
   reports stale/future, the verdict carries exactly one reason —
   `stale-catalog` or `future-catalog` — and no other check runs.
2. **Support / provider / operation / capability / typed-requirement checks**
   accumulate in fixed first-seen order; duplicates are removed.
3. **Evidence checks run ONLY when `supportState` is eligible**
   (`configured`, `conformance-tested`). A non-eligible support state therefore
   never co-occurs with an evidence reason.

## Catalog gate (short-circuits all other reasons)

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `stale-catalog` | The catalog snapshot is older than `maxCatalogAgeMs`. Nothing downstream can be trusted, so every candidate is rejected on this alone. | Unknown | Refresh the catalog snapshot / fixtures and re-run. |
| `future-catalog` | The catalog snapshot is timestamped after evaluation time (`now`) — clock skew or a bad snapshot. | Unknown | Check system clock and snapshot provenance; re-take the snapshot. |

## Support state

Template: `support-state:<state>` — emitted once, with the candidate's actual
`supportState`, whenever it is not eligible. Eligible states (never emitted):
`configured`, `conformance-tested`. Emitted for any other `SupportState` value
(`src/support.js`): `catalogued`, `unavailable`, `unsupported` — and any future
non-eligible state verbatim.

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `support-state:catalogued` | Route is known to the catalog but not configured for use. | Blocked | Configure the route (support configuration with operations + evidence). |
| `support-state:unavailable` | Route is marked unavailable upstream. | Blocked | Wait for provider availability or pick another route. |
| `support-state:unsupported` | Route is marked unsupported for this operation set. | Blocked | Pick a route whose support state is `configured` or `conformance-tested`. |

## Provider and operation

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `provider-not-allowed` | The candidate's provider is not in `request.providerAllowlist`. | Blocked | Add the provider to the allowlist, or pick an allowed provider's route. |
| `operation-not-catalogued` | The requested operation is not in the candidate's `catalogOperations`. | Blocked | Request an operation the route catalogues, or pick another route. |
| `operation-not-configured` | The requested operation is not in the candidate's `configuredOperations`. | Blocked | Configure the operation for the route, or pick another route. |

## Capabilities (legacy list + typed flags)

Templates: `missing-capability:<name>` / `unsupported-capability:<name>`.
They apply to BOTH the legacy `requiredCapabilities` any-name check AND the
typed boolean flags, which map `toolCalling` -> `toolUse`,
`structuredOutput` -> `structuredOutput`, `reasoning` -> `reasoning`. The
token-limit checks also reuse the `missing-capability:` template with
`<name>` = `contextWindow` / `maxOutputTokens` (see below).

- **missing** = the value is absent or `null` (unknown data). Fail closed.
- **unsupported** = the value is present but not `true` (known exclusion).

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `missing-capability:<name>` | Capability data for `<name>` is absent. We do not know whether the route supports it. | Unknown | Backfill the capability data in the catalog entry; until then the route stays unselectable. |
| `unsupported-capability:<name>` | The route is known not to support `<name>`. | Blocked | Drop `<name>` from the requirements, or pick a route that supports it. |

## Token limits

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `missing-capability:contextWindow` | No context-window figure is known and `minContextWindow` was required. | Unknown | Backfill `limits.contextWindow` in the catalog entry. |
| `insufficient-context-window` | Known context window is below `minContextWindow`. | Blocked | Lower the requirement, or pick a larger-context route. |
| `missing-capability:maxOutputTokens` | No max-output figure is known and `maxOutputTokens` was required. | Unknown | Backfill `limits.maxOutputTokens` in the catalog entry. |
| `insufficient-max-output-tokens` | Known max output is below the required `maxOutputTokens`. | Blocked | Lower the requirement, or pick a route with a larger output budget. |

## Modalities

Templates: `missing-modality:input:<value>` / `missing-modality:output:<value>`
— emitted per required modality the candidate does not list. `<value>` is any
modality string from the requirement (seen in tests: `text`, `image`,
`audio`).

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `missing-modality:input:<value>` | The route does not accept `<value>` as input (or its input modalities are unknown). | Unknown | Backfill `modalities.input`, or pick a route accepting `<value>`. |
| `missing-modality:output:<value>` | The route does not produce `<value>` as output (or its output modalities are unknown). | Unknown | Backfill `modalities.output`, or pick a route producing `<value>`. |

## Evidence (only when `supportState` is eligible)

| Reason | Meaning | Display | Operator remediation |
| --- | --- | --- | --- |
| `missing-evidence` | The candidate carries no support evidence at all. | Unknown | Attach evidence (`observedAt`) to the support configuration. |
| `invalid-evidence` | `evidence.observedAt` is not a parseable timestamp. | Unknown | Fix the `observedAt` value to a valid ISO timestamp. |
| `future-evidence` | Evidence is timestamped after evaluation time — clock skew or bad data. | Unknown | Check the clock / evidence pipeline; correct `observedAt`. |
| `stale-evidence` | Evidence is older than `maxEvidenceAgeMs`. | Unknown | Re-verify the route to produce fresh evidence. |

## Display rule summary

`UNKNOWN_REASON_SIGNALS` (`web/eligibility.js`): the prefixes
`missing-capability:` and `missing-modality:`, plus the exact codes
`missing-evidence`, `invalid-evidence`, `future-evidence`, `stale-evidence`,
`stale-catalog`, and `future-catalog`, render **Unknown** (fail-closed, not
selectable). Any verdict carrying any other reason renders **Blocked**.

## Out of scope (NOT evaluator reasons — do not look them up here)

- `missing-rates` — a snapshot gap reported by `src/snapshot.js`, never an
  evaluator reason.
- `stale-catalog-fail-closed` — a catalog-entry validation class used in
  `test/eligibility-matrix.test.js`, never an evaluator reason.

If the evaluator ever emits a code missing from this glossary, that is a bug:
document it here and file a card (guard: `test/eligibility-reasons-glossary.test.js`).
