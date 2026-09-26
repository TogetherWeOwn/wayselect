# Wayselect catalog search/filter acceptance (TOG-5051)

Executable contract for the next Wayselect catalog search/filter slice.
**No backend change in this card**: `src/` and `web/` are untouched. The
deliverable is this spec plus `bin/accept-wayselect-search-filter`
(`npm run accept:search-filter`), which runs green against today's staging
fixtures and is reused as the gate when the catalog slice PR lands.

Related: [TOG-5010](/TOG/issues/TOG-5010) (web acceptance; its §2 forward
contract covers the same filters at the HTTP/index layer),
[TOG-4916](/TOG/issues/TOG-4916) (search/filter UI slice, blocked).

## 1. User story (smallest sellable improvement)

As a buyer browsing the Wayselect catalog, I can narrow the listing set by
text query, capability, modality, and operation, so I find an eligible route
without reading every entry.

Smallest sellable slice: deterministic, explainable filtering over the
fixture corpus. No ranking, no relevance scores, no pagination, no backend
writes, no live data. Order is always normalized catalog order (no
re-ranking), so results are stable and diffable.

Goal link: company north star "Agent-Run Revenue, Zero Owner Hours" via
validated-bet discipline — this card ships requirements + acceptance before
build, per the CPO revenue contribution rule (no engineering card without a
stated user outcome and acceptance criteria).

## 2. Filter contract

The future slice filters **normalized catalog entries** (`src/catalog.js`
output) derived from `fixtures/catalog.synthetic.json`. Field vocabulary is
the normalized one; the web fixture names map 1:1 and must NOT be renamed to
"align" layers:

| Web fixture name (`web/stub-listing.js`) | Normalized name (`src/catalog.js`) |
| --- | --- |
| `attachment` | `attachment` |
| `reasoning` | `reasoning` |
| `tool_call` | `toolUse` |
| `structured_output` | `structuredOutput` |

| # | Rule |
| --- | --- |
| R-q | `q` is a case-insensitive substring match against `name`, `routeId` (`providerId/modelId`), and `providerId`. Absent or blank `q` disables text filtering. (Catalog entries carry no provider display name, so unlike the web layer there is no `providerName` haystack — see G1.) |
| R-cap | `capability` is repeatable; valid names are exactly `attachment`, `reasoning`, `toolUse`, `structuredOutput`. An entry is kept only when **all** named capabilities are `true`. `null`/missing capability data fails closed (entry excluded, never guessed). An unknown name is an error naming the valid values (fail closed, never ignored). |
| R-mod | `modality` is repeatable; an entry is kept when **every** requested modality appears in its coverage (union of raw `modalities.input` ∪ `modalities.output`). The slice MUST carry modality coverage per entry (raw union or equivalent) because normalized entries today only derive `imageInput`/`textInput`/`textOutput` flags. Modality vocabulary is **open**: an unmatched value yields an empty result, not an error (future corpora may add `audio`, `video`, …). |
| R-op | `operation` is repeatable; valid values are exactly the `catalogOperations` vocabulary (`chat`, `vision-chat`). Kept when the entry's `catalogOperations` includes **every** requested operation. Unknown values error naming the valid values. |
| R-combine | AND across `q` × capabilities × modalities × operations. |
| R-order | Result order is normalized catalog order (providers then models sorted; effectively lexicographic `routeId`). No re-ranking. Every check below is order-sensitive. |
| R-empty | Filters matching nothing return an empty list — not an error. |
| R-fixture | The script reads `fixtures/catalog.synthetic.json` through the real `normalizeCatalog` boundary and asserts 6 entries with intact provenance. A fixture change that alters any row below must update this table in the same PR. |

## 3. Expected-results table (fixtures/catalog.synthetic.json, 6 entries)

Normalized order: `legacy/old-chat`, `northstar/alpha-chat`,
`northstar/image-lite`, `northstar/unknown-tools`, `orbit/orbit-chat`,
`orbit/retired-chat`.

Capability facts used below: `toolUse` is true for all except `image-lite`
(false) and `unknown-tools` (null); `attachment` only on `image-lite`;
`reasoning` only on `orbit-chat`; `structuredOutput` on `alpha-chat` +
`orbit-chat`. Operations: everything except `image-lite` offers `chat`;
only `image-lite` offers `vision-chat`. Modality coverage: everything covers
`text`; only `image-lite` covers `image`.

| Check | Filter | Expected `routeId`s (in order) |
| --- | --- | --- |
| A1 | load + `normalizeCatalog` | 6 entries; provenance `synthetic://wayselect/fixture-v1`, ISO timestamp, `sha256:<64hex>` |
| A2 | route order | `legacy/old-chat`, `northstar/alpha-chat`, `northstar/image-lite`, `northstar/unknown-tools`, `orbit/orbit-chat`, `orbit/retired-chat` |
| Q1 | (no params) | all 6 |
| Q2 | `q=alpha` | `northstar/alpha-chat` |
| Q3 | `q=CHAT` (case-insensitive) | `legacy/old-chat`, `northstar/alpha-chat`, `orbit/orbit-chat`, `orbit/retired-chat` |
| Q4 | `q=orbit` (provider + name match) | `orbit/orbit-chat`, `orbit/retired-chat` |
| Q5 | `q="  "` (blank) | all 6 |
| C1 | `capability=toolUse` | `legacy/old-chat`, `northstar/alpha-chat`, `orbit/orbit-chat`, `orbit/retired-chat` |
| C2 | `capability=attachment` | `northstar/image-lite` |
| C3 | `capability=reasoning` | `orbit/orbit-chat` |
| C4 | `capability=structuredOutput` | `northstar/alpha-chat`, `orbit/orbit-chat` |
| C5 | `capability=toolUse,structuredOutput` | `northstar/alpha-chat`, `orbit/orbit-chat` |
| C6 | `capability=attachment,toolUse` | (empty — not an error) |
| C7 | `unknown-tools` absent from every C1–C4 result | `null` capabilities fail closed |
| M1 | `modality=image` | `northstar/image-lite` |
| M2 | `modality=text` | all 6 |
| M3 | `modality=image,text` | `northstar/image-lite` |
| M4 | `modality=audio` (outside today's vocabulary) | (empty — not an error, per R-mod) |
| O1 | `operation=chat` | all except `northstar/image-lite` (5) |
| O2 | `operation=vision-chat` | `northstar/image-lite` |
| X1 | `q=chat` + `capability=toolUse` | `legacy/old-chat`, `northstar/alpha-chat`, `orbit/orbit-chat`, `orbit/retired-chat` |
| X2 | `q=image` + `capability=attachment` + `modality=image` | `northstar/image-lite` |
| X3 | `q=chat` + `capability=attachment` | (empty — not an error) |
| F1 | `capability=nope` | error naming the valid values |
| F2 | `operation=telepathy` | error naming the valid values |

## 4. Runnable acceptance script (under 5 minutes)

```sh
node --version              # 20+
npm test                    # unit suite, ~1s (untouched by this card)
npm run accept:search-filter  # this script, typically < 1s
```

`bin/accept-wayselect-search-filter` (zero dependencies, stdlib only plus the
real `src/catalog.js` boundary) embeds the contract reference filter from §2
and checks every row of §3. Expected tail output today:

```
SUMMARY: 25 pass, 0 fail — 0.1s (budget 5m)
```

Exit code is 0 on zero failures, 1 otherwise. There are no skips: every check
is pass/fail and unambiguous, and any reviewer can re-run the three commands
above from a clean checkout.

## 5. Reuse path (seven-day metric)

By 2026-10-03: this exact command executes green (0 fail) on the catalog
slice PR — either against unchanged fixtures, or against updated fixtures
with this table amended in the same PR. When a real implementation lands
(e.g. `src/search.js`), the slice PR keeps this script as the golden table
and extends its probe section to cross-check the implementation against the
reference filter; until then the reference filter inside the script IS the
executable contract.

## 6. Sign-off, kill/scale

- [ ] CPO: contract states the user outcome; table derived from fixtures, not invented.
- [ ] Engineer (catalog slice): table rows are directly implementable; R-mod names the coverage the slice must carry.
- [ ] QA: pass/fail semantics independently reproducible (`npm run accept:search-filter` from a clean checkout).

Kill rule: if no catalog slice PR reuses this script within 14 days, keep the
fixture-guard half (A/Q/C/M/O/X checks are green and cost <1s) and archive
only the F-row error-shape rows if the slice chooses a different error
mechanism. Scale rule: once executed green on the slice PR, this command
becomes a required gate for every later PR that touches `fixtures/catalog.*`
or the filter implementation. Review date: 2026-10-03.

## 7. Accepted gaps

- G1: catalog entries carry no provider display name, so `q` matches
  `providerId` only (web layer additionally matches `providerName`). Accepted:
  layers document their own haystacks; no renaming to force alignment.
- G2: no `imageOutput` derived flag exists yet (all fixture outputs are
  `text`). Accepted: R-mod matches against raw modality coverage, so a future
  image-output entry works with no contract change.
- G3: no pagination, no ranking. Accepted: the corpus is 6 entries;
  revisit only if it grows past 50.
