# v2-cue-extraction (after): interpret, then match

Before touching the index, interpret the buyer's raw text into a structured
filter, then apply it. Interpretation is deterministic and fail-closed:

1. Normalize: trim, lowercase, split on non-alphanumeric runs.
2. Extract cues (consumed words, never reused as keywords):
   - `attachment` capability when any word is in
     {attach, attachment, upload, file, picture, photo, screenshot}
   - `tool_call` capability when any word is in
     {tool, tools, function, functions, api}
   - `structured_output` capability when any word is in
     {structured, json, schema}
   - `reasoning` capability when any word is in
     {reasoning, reason, think, thinking, cot}
   - `image` modality when any word is in
     {image, picture, photo, vision, visual, camera, screenshot}
   - `text` chat operation (text in AND text out) when any word is in
     {chat, conversation, talk, message, chatting}
3. Drop stopwords {with, a, an, the, model, models, for, me, my, and, or,
   to, of, in, on, that, can, do, does, need, want, looking, find, show,
   give, get}. Remaining words are keyword tokens.
4. Filter: keep listings where EVERY required capability is exactly `true`
   (false, null, or missing fails closed — the listing is excluded, never
   guessed) and every required modality is present (`image`: input or
   output per S5; `text`: text in AND text out, i.e. the `chat` operation).
5. Rank survivors: +2 when the whole normalized query is a substring of
   `entry.name + route + providerName`, +1 per keyword token found as a
   substring. Keywords only add ranking — every survivor matched all required
   cues, so the cue match itself keeps it in the list even when its keywords
   score nothing. (Filters that match nothing still yield zero survivors, so
   the honest no-match path survives.) Ties keep stub order (S7). No
   re-ranking beyond this score, no randomness, no network calls.

This prompt version is the "after" column in the TOG-5492 regression eval.
