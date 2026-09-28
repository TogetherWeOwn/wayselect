# Search-prompt regression eval — results (TOG-5492, extended TOG-5748)

30 fixed queries over the 3 stub listings in `web/stub-listing.js`.
`before` = v1-baseline (raw substring pass-through, shipped S2 rule);
`mid` = v2-cue-extraction (interpret-then-match);
`after` = v3-negation-scope (v2 plus negation scope). Top-1 compared to the
golden `expectedTop1` in `queries.json` (`∅` = honest no-match).

| ID | Query | Expected top-1 | Before top-1 | Mid top-1 | After top-1 | Before | Mid | After | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Q01 | `alpha` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | exact name fragment |
| Q02 | `Alpha Chat` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | exact full name |
| Q03 | `ALPHA CHAT` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | case-insensitivity (S2) |
| Q04 | `  alpha  ` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | padded whitespace trims |
| Q05 | `northstar` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | provider-name match hits all three; stub order (S7) puts alpha-chat first |
| Q06 | `image` | northstar/image-lite | northstar/image-lite | northstar/image-lite | northstar/image-lite | ✓ | ✓ | ✓ | name fragment and image-modality cue |
| Q07 | `Image Lite` | northstar/image-lite | northstar/image-lite | northstar/image-lite | northstar/image-lite | ✓ | ✓ | ✓ | exact full name |
| Q08 | `picture` | northstar/image-lite | ∅ (no match) | northstar/image-lite | northstar/image-lite | ✗ | ✓ | ✓ | synonym of image; not a substring of any name |
| Q09 | `photo upload` | northstar/image-lite | ∅ (no match) | northstar/image-lite | northstar/image-lite | ✗ | ✓ | ✓ | image + attachment cues; no name overlap |
| Q10 | `tool` | northstar/alpha-chat | northstar/unknown-tools | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | substring alone top-1s the Unknown Tools listing; tool_call cue should prefer Alpha Chat |
| Q11 | `structured output` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | structured_output cue; only Alpha Chat has it true |
| Q12 | `json` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | shorthand for structured output |
| Q13 | `chat with tools` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | natural phrasing; whole-string substring matches nothing |
| Q14 | `vision` | northstar/image-lite | ∅ (no match) | northstar/image-lite | northstar/image-lite | ✗ | ✓ | ✓ | image-modality synonym; matches no name |
| Q15 | `unknown` | northstar/unknown-tools | northstar/unknown-tools | northstar/unknown-tools | northstar/unknown-tools | ✓ | ✓ | ✓ | name fragment; no cue words involved |
| Q16 | `orbit` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | ✓ | provider on the allowlist but absent from stub listings; honest no-match |
| Q17 | `zzz-no-such-listing` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | ✓ | mirrors the S8 empty-state probe; no-match |
| Q18 | `` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | ✓ | blank query means no text filtering (S3); stub order first |
| Q19 | `reasoning model` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | ✓ | reasoning cue matches no listing (Alpha/Image false, Unknown null); honest no-match |
| Q20 | `attach an image` | northstar/image-lite | ∅ (no match) | northstar/image-lite | northstar/image-lite | ✗ | ✓ | ✓ | attachment + image cues; only Image Lite satisfies both |
| Q21 | `no image` | northstar/alpha-chat | ∅ (no match) | northstar/image-lite | northstar/alpha-chat | ✗ | ✗ | ✓ | negated image cue: v2 reads it as a requirement and top-1s Image Lite; only Alpha Chat provably lacks image |
| Q22 | `chat without image` | northstar/alpha-chat | ∅ (no match) | ∅ (no match) | northstar/alpha-chat | ✗ | ✗ | ✓ | positive chat + negated image; v2 requires both and no-matches |
| Q23 | `model without tools` | northstar/image-lite | ∅ (no match) | northstar/alpha-chat | northstar/image-lite | ✗ | ✗ | ✓ | negated tool_call: Alpha Chat has tools; Unknown Tools is unknown (fail-closed), so only Image Lite (explicitly false) answers |
| Q24 | `not a picture model` | northstar/alpha-chat | ∅ (no match) | northstar/image-lite | northstar/alpha-chat | ✗ | ✗ | ✓ | leading negation over a picture cue; v2 top-1s the picture listing |
| Q25 | `image model with tools` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | ✓ | impossible conjunction: no listing combines image input with tool_call=true; honest no-match under all versions |
| Q26 | `function calling` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | positive control: multi-word tool_call phrasing; v2 already answers |
| Q27 | `screenshot` | northstar/image-lite | ∅ (no match) | northstar/image-lite | northstar/image-lite | ✗ | ✓ | ✓ | positive control: one word cues both attachment and image; v2 already answers |
| Q28 | `schema` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | northstar/alpha-chat | ✗ | ✓ | ✓ | positive control: structured_output shorthand; v2 already answers |
| Q29 | `no chat` | northstar/image-lite | ∅ (no match) | northstar/alpha-chat | northstar/image-lite | ✗ | ✗ | ✓ | negated chat operation: Alpha Chat is text-in/text-out; v2 top-1s it anyway |
| Q30 | `image no chat` | northstar/image-lite | ∅ (no match) | ∅ (no match) | northstar/image-lite | ✗ | ✗ | ✓ | mixed polarity: positive image + negated chat; Image Lite has image input but no text-in, so it is not a chat operation |

**Summary: before 13/30, mid 24/30, after 30/30 — v2 fixed 11, v3 fixed 6, 0 regressed vs v1.**

Reproducibility: `node bin/eval-wayselect-search-prompts --seed 5492` (stdlib only,
no network). Determinism self-check passed: all versions are repeatable, and
v2/v3 top-1s on non-blank queries are shuffle-invariant with seed 5492 (S7
stub-order tie-breaks). v1 multi-matches preserve caller order by design (the
server always feeds canonical stub order, so production top-1s reproduce);
blank queries (S3) preserve caller order in all versions.
Content hashes — queries.json `1a67cdd10010`, v1-baseline.md `40a0ecdadde2`,
v2-cue-extraction.md `0a1b7b2bbcc0`, v3-negation-scope.md `442f180e630a`. Run time 0.0s (budget 90 run-min).
