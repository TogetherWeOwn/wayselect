# Slow-network knob: `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` (TOG-6383)

Gap T5 (round-3 gap list, [TOG-6346](/TOG/issues/TOG-6346)): the
fragment-delay knob in `web/server.js` had behavior tests but no operator
doc. This doc pins the contract so an operator can use the knob without
reading source.

## What it does

Delays the listing-detail JSON fragment — the `{ html }` payload the
shell's inline fetch negotiates with `Accept: application/json` — so a
developer can watch the skeleton loading state settle on a slow network.
It delays the fragment only. The shell first paint (`GET
/listings/:provider/:model` without JSON negotiation) is never delayed.

Implementation: `web/server.js` (detail route, fragment branch).
Behavior pins: `test/listing-detail-loading.test.js` (600 ms delays the
fragment, shell stays fast), `test/fragment-delay-knob.test.js`
(invalid values are immediate; this doc stays in sync with source).

## Contract

| Item | Value |
| --- | --- |
| Env var | `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` |
| Units | Milliseconds, decimal integer |
| Default | Unset → `"0"` → no delay |
| Scope | `GET /listings/:provider/:model` with `Accept: application/json`, preview flag on |
| Parse | `Number.parseInt(String(value ?? "0"), 10)`; only finite values `> 0` delay, via `setTimeout` |

Verified parse table (matches the implementation exactly):

| Setting | Effect |
| --- | --- |
| unset, `"0"`, `""`, `"abc"` | No delay (unset/`""`/`"abc"` parse to `0`/`NaN`, which fail the `> 0` gate) |
| `"-5"` | No delay (non-positive) |
| `"600"` | Fragment delayed 600 ms |
| `"600ms"` | Fragment delayed 600 ms (`parseInt` prefix parse — do not rely on this) |
| `" 300 "` | Fragment delayed 300 ms (surrounding whitespace tolerated) |
| `"3.9"` | Fragment delayed 3 ms (`parseInt` truncates — use integers) |

Out of scope by construction: the shell first paint, the flag-off path
(404 precedes the knob), the listing index, the purchase stub, and
`/healthz` are all unaffected whatever the knob is set to.

## Operator recipes

Normal dev and demo work: leave the knob unset (zero behavior change).

To exercise the skeleton loading state:

```sh
WAYSELECT_PREVIEW=1 WAYSELECT_DETAIL_FRAGMENT_DELAY_MS=1500 npm run preview
```

then load a listing-detail page and confirm the skeleton paints
immediately while the content arrives ~1.5 s later. Remove the knob when
done — it is test/dev only and must never be set in shared, staging, or
production environments (this repo has no production activation path).
