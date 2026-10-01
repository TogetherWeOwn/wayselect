# Wayselect first-run onboarding spec (TOG-5229)

Product spec for Wayselect first-run onboarding: empty states, picker copy,
and the eligibility-explain entry point. Pairs with
[TOG-4962](/TOG/issues/TOG-4962) (two-web onboarding empty-states + picker
copy implementation) **without overlapping it** — this card is spec +
acceptance criteria only and writes no product code; that card is
implementation. This doc is the copy source of truth both sides sign off.

Non-goals (inherited): no live provider calls, no live-guild action (distinct
from [TOG-4709](/TOG/issues/TOG-4709)), no credentials, no network access, no
backend writes. All prices are synthetic list-price estimates; all listings
are stub data.

## 1. First-run path

First-run = a new user arriving with no prior state. The path this spec
covers, in order:

1. **Preview gate** — `WAYSELECT_PREVIEW` on: enter; off: Preview-unavailable
   page (§3, O1).
2. **Picker** — intent/role picker implemented on
   [TOG-4962](/TOG/issues/TOG-4962): loading → populated | empty → pick →
   picked | unavailable | stale (§3, O2–O7).
3. **Listing index** — stub listings with per-model eligibility badges
   (granted / blocked / unknown, fail-closed).
4. **Listing detail + eligibility-explain entry point** — the ONLY place a
   first-run user meets eligibility reasoning (§4, O12).
5. **Terminal stub** — purchase CTA is disabled and always refuses (§3, O14).

## 2. Copy deck (v1, pinned)

### 2a. Picker copy — owned by TOG-4962, pinned verbatim from its 7 preview evidences

No word on this list changes without a Code Reviewer pass on this doc. The
evidence files are `preview-loading/empty/picked/unavailable/stale.html` plus
`picker-empty/session.json` on [TOG-4962](/TOG/issues/TOG-4962).

| Key | Exact copy |
| --- | --- |
| Heading | `You're in - that was the whole application.` |
| Intro | `What do you want to do right now? Pick below and I will point you at the right room. You can change your mind any time - this picks a destination for tonight, not a label forever.` |
| Placeholder prompt | `What do you want to do right now?` |
| Option `find-players` | 🎲 `Find people to play with` — `Post the game, your platform and a start time.` |
| Option `join-voice` | 🔊 `Join voice now` — `The Lobby is open - see who is around.` |
| Loading | `Loading picker…` (`role="status"`, `data-testid="picker-loading"`) |
| Empty title | `Nothing to pick right now.` (`data-testid="picker-empty-title"`) |
| Empty body | `Every room this picker could point you at is closed to you at the moment. Nothing was changed - try again in a moment, or say hello in the welcome channel and someone will grab you.` (`data-testid="picker-empty-body"`) |
| Picked ack | `On it - head to <#CHANNEL>.` (channel mention varies; `role="status"`, `data-testid="picker-ack"`) |
| Unavailable ack | `Those rooms are not open to you right now. Nothing was changed - try again in a moment, or say hello in the welcome channel and someone will grab you.` (`role="status"`, `data-testid="picker-ack"`) |
| Stale ack | `That option is gone or stale - the panel was probably replaced by a newer one. Nothing was changed. Open the picker again and choose afresh.` (`role="alert"`, `data-testid="picker-ack"`) |

Picker rules (pinned alongside the copy): preview flag
`TWO_ONBOARDING_PICKER_PREVIEW` is off unless exactly `1`; picking never
performs a live-guild write; options render as
`li[data-testid="picker-option"][data-key]`; panel state is exposed as
`main[data-state]` ∈ `loading | empty | picked | unavailable | stale`;
populated vs empty is the `options: [...]` vs `options: []` JSON shape.

### 2b. Wayselect preview copy — shipped, quoted from code

| Key | Exact copy (source) |
| --- | --- |
| Index banner | `Preview build: stub data only.` (`web/listing-detail.js`) |
| Detail banner | `Preview build: stub data only. No purchase is processed.` |
| Preview unavailable (flag off) | H1 `Preview unavailable` + `This page is behind the WAYSELECT_PREVIEW flag, which is currently off.` |
| Listing not found | H1 `Listing not found` + `No stub listing matches <p/m>.` + search hint (`searching the listings` → `/listings?q=<model>`) + `Back to listings` → `/listings` |
| Filters match nothing (next slice, S8) | `No listings match these filters.` + `Clear filters` link → `/listings` |
| Eligibility granted | Badge `Granted` + `Eligible for the preview capability check (operation chat, required capabilities toolUse, providers northstar, orbit).` (`web/eligibility.js`) |
| Eligibility blocked | Badge `Blocked` + `Not eligible for the preview capability check (…).` |
| Eligibility unknown (fail-closed) | Badge `Unknown` + `Eligibility unknown — capability data unavailable; not selectable until capability data is available.` |
| Capability cell unknown | Badge `Unknown` (never Yes, never silently No) |
| Cost / modality unknown | `unknown` |
| Purchase CTA | Disabled button `Purchase (stub — disabled in preview)` + `No backend writes: the purchase endpoint refuses with 403 preview_only while the flag gates this page.` |
| Purchase refusal JSON | `{error:"preview_only", message:"Purchases are disabled in preview. No backend writes."}` (403, any flag state) |
| Unknown path JSON | `{error:"not_found"}` (404) |
| Wrong-method purchase JSON | `{error:"method_not_allowed"}` (405) |

`WAYSELECT_PREVIEW` truthy (trimmed, case-insensitive): `1`, `true`, `yes`,
`on`. Anything else, including unset, is off.

### 2c. Proposed by this spec (new decisions for reviewer approval)

- **P1 — unknown-filter 400 template** (next search/filter slice; today only
  specified as "names the valid values"). Required shape: 400 error page with
  H1 `Invalid filter` and body `Unknown capability "VALUE". Valid values:
  attachment, reasoning, tool_call, structured_output.` (modality variant names
  its own valid list). Fail closed, never ignore the value.
- **P2 — drop-off funnel events** (§5). Names and triggers defined here;
  emission is a follow-up, not this card.
- **P3 — no new explainer page.** Reason codes render verbatim in `<code>`
  inside the detail Eligibility section (§4). A friendlier explainer is
  explicitly out of this slice (smallest sellable).

## 3. State table (every first-run state)

| # | State | Trigger | Rendered result | Copy ref | Owner |
| --- | --- | --- | --- | --- | --- |
| O1 | Preview flag off | `GET /listings` or detail, flag off | 404 Preview-unavailable page | §2b | Shipped |
| O2 | Picker loading | Panel opened, options not yet resolved | `main[data-state="loading"]`, loading copy | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O3 | Picker populated | Options resolve non-empty | Heading + intro + option list | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O4 | Picker empty | Options resolve empty | `main[data-state="empty"]`, empty title + body | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O5 | Option picked | User picks an available option | `main[data-state="picked"]`, picked ack | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O6 | Pick unavailable | Picked rooms closed to the user | `main[data-state="unavailable"]`, unavailable ack; nothing changed | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O7 | Pick stale | Panel replaced before pick lands | `main[data-state="stale"]`, stale ack; nothing changed, re-open picker | §2a | [TOG-4962](/TOG/issues/TOG-4962) |
| O8 | Index with eligibility badges | Flag on, `GET /listings` | 200, stub order, Granted/Blocked/Unknown badge per listing | §2b | Shipped (TOG-5221 display) |
| O9 | Filters match nothing | Next slice: valid filters, zero results | 200, S8 copy + clear link (not an error) | §2b | Spec-required, unimplemented |
| O10 | Unknown filter value | Next slice: invalid capability/modality | 400 page per P1 template | §2c P1 | Spec-required, unimplemented |
| O11 | Unknown listing | Flag on, no stub matches `p/m` | 404 Listing-not-found page + back link | §2b | Shipped |
| O12 | Eligibility explain | Detail page Eligibility section | Badge + headline + verbatim `<code>` reason list (§4) | §2b | Shipped; codes extend in place |
| O13 | No eligible route | CLI parity context (all candidates excluded) | `no-eligible-route`, every candidate explains, `selected=null` | Eligibility acceptance §2 | Reference only (not a web surface) |
| O14 | Purchase stub refused | Disabled CTA / `POST …/purchase` | Disabled button; 403 `preview_only` JSON; no write | §2b | Shipped, intentional |
| O15 | Unknown path / wrong method | Anything else | 404 `{error:"not_found"}` / 405 `{error:"method_not_allowed"}` JSON | §2b | Shipped (machine states, no copy) |

## 4. Eligibility-explain entry point

First-run users meet eligibility reasoning in exactly one place: the
**Eligibility section on the listing-detail page**, reached via the index
badges (O8 → O12). Rules:

1. Unknown fails closed: missing capability data, malformed evaluations, and
   evaluation failures render `Unknown` with not-selectable copy — never
   granted, never silently blocked.
2. Reason codes render verbatim in `<code>` (e.g. `missing-capability:toolUse`,
   `provider-not-allowed`, `stale-catalog`, `support-state:unsupported`).
3. New reason codes (e.g. richer typed requirements from a future slice) extend
   the O12 list **in place**; no new explainer page (P3).
4. The preview capability check is frozen and synthetic: operation `chat`,
   required capability `toolUse`, providers `northstar, orbit`. The headline
   names it so users never mistake it for a live permission grant.

## 5. Instrumentation — seven-day metric

Funnel (event → trigger → hook):

| Event | Trigger | Hook |
| --- | --- | --- |
| `onboarding_picker_shown` | Panel renders any of O2–O4 | `main[data-state]` value |
| `onboarding_picker_option_picked` | User picks (`key`) | `picker-option[data-key]` |
| `onboarding_picker_empty_shown` | O4 renders | `picker-empty-title` present |
| `onboarding_picker_ack_shown` | O5/O6/O7 ack renders | `data-state` = picked/unavailable/stale |
| `preview_listing_viewed` | Detail 200 | route `p/m` |
| `eligibility_section_viewed` | O12 rendered (granted/blocked/unknown) | badge state |

Drop-off = `shown → picked` conversion plus O4/O6/O7 rates, measured on
preview within 7 days (by 2026-10-03). Emission is a follow-up slice, not this
card and not [TOG-4962](/TOG/issues/TOG-4962); the `data-testid`/`data-state`
hooks above are the emission contract it builds against.

## 6. Acceptance checklist

- [ ] Web Engineer: every [TOG-4962](/TOG/issues/TOG-4962) empty state
  (loading / empty / picked / unavailable / stale, plus populated vs empty
  picker JSON) has its copy pinned in §2a and a row in §3 (O2–O7). Nothing in
  the 7 preview evidences is missing from this doc.
- [ ] Code Reviewer: one pass approving the copy (§2a verbatim pins, §2b
  shipped quotes, §2c P1–P3 proposals). Docs-only change: no
  Security/CISO/QA review.
- [ ] No product-code changes on this card (this doc + PR meta only).
- [ ] Seven-day metric (by 2026-10-03): drop-off funnel from §5 instrumented
  on preview; checklist replayed green against the head SHA.

Kill rule: if no slice emits §5 events within 14 days, archive §5 instead of
maintaining it. Scale rule: once emitted, the §6 checklist becomes a required
gate for every subsequent onboarding slice. Review date: 2026-10-03.

## 7. Accepted gaps

- G1: O9/O10/P1 cover the unbuilt search/filter slice as spec-required
  forward contract (mirrors the existing §2 forward contract in
  `docs/wayselect-web-acceptance.md`).
- G2: §5 event emission is a follow-up; this card defines names, triggers,
  and hooks only.
- G3: O13 (CLI `no-eligible-route`) is reference parity for reason-code
  vocabulary, not a web surface this spec changes.
