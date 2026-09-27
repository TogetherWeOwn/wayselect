# v3-negation-scope (after): interpret with negation, then match

v2 treats every cue word as a positive requirement, so buyers who say what
they do *not* want get the opposite of what they asked for: `no image`
top-1s Image Lite, `model without tools` top-1s Alpha Chat (the tools
listing), and `chat without image` no-matches. v3 adds negation scope to
the v2 interpreter; everything else (normalization, stopwords, scoring,
S7 stub-order tie-breaks, S3 blank passthrough) is unchanged.

1. Normalize: trim, lowercase, split on non-alphanumeric runs (same as v2).
2. Negation scope: tokens in {no, not, none, never, without, except, minus,
   exclude, excluding} open a forward scope — every cue word AFTER the
   marker in the same query is negated. Cue words before any marker stay
   positive (`image no chat`: image required, chat excluded).
3. Extract cues (same cue sets as v2). A capability/modality field is
   *excluded* when all of its cue hits are negated; a positive mention
   anywhere wins over negation (explicit positive mention wins — fail
   closed toward answering). Negation markers are consumed words, never
   keywords (so `without` never pollutes ranking).
4. Filter: positive cues apply exactly as in v2 (capability must be
   exactly `true`; modality must be present). Excluded cues apply the
   mirror, still fail-closed:
   - excluded capability: the field must be explicitly `false`.
     `true`, `null`, or missing excludes the listing — an unknown
     `tool_call` is not evidence of *no* tools, so Unknown Tools never
     answers `model without tools`; only Image Lite (`tool_call: false`)
     does.
   - excluded `image` modality: neither input nor output contains image.
   - excluded `chat` operation: not (text in AND text out).
5. Rank survivors exactly as in v2 (+2 whole-string substring, +1 per
   keyword, negated-or-required cue match keeps zero-keyword survivors,
   ties keep stub order S7). No randomness, no network calls.

Known limits: `n't` contractions (`don't want image`) are not negation
markers — the tokenizer splits them into `don`/`t`. A negation marker
with no cue word in scope (e.g. the `no` inside `zzz-no-such-listing`)
is a no-op, so the honest no-match path survives.

This prompt version is the "after" column in the TOG-5748 extension of
the regression eval (30 queries; before = v1, mid = v2).
