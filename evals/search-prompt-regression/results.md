# Search-prompt regression eval — results (TOG-5492)

20 fixed queries over the 3 stub listings in `web/stub-listing.js`.
`before` = v1-baseline (raw substring pass-through, shipped S2 rule);
`after` = v2-cue-extraction (interpret-then-match). Top-1 compared to the
golden `expectedTop1` in `queries.json` (`∅` = honest no-match).

| ID | Query | Expected top-1 | Before top-1 | After top-1 | Before | After | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q01 | `alpha` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | exact name fragment |
| Q02 | `Alpha Chat` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | exact full name |
| Q03 | `ALPHA CHAT` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | case-insensitivity (S2) |
| Q04 | `  alpha  ` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | padded whitespace trims |
| Q05 | `northstar` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | provider-name match hits all three; stub order (S7) puts alpha-chat first |
| Q06 | `image` | northstar/image-lite | northstar/image-lite | northstar/image-lite | ✓ | ✓ | name fragment and image-modality cue |
| Q07 | `Image Lite` | northstar/image-lite | northstar/image-lite | northstar/image-lite | ✓ | ✓ | exact full name |
| Q08 | `picture` | northstar/image-lite | ∅ (no match) | northstar/image-lite | ✗ | ✓ | synonym of image; not a substring of any name |
| Q09 | `photo upload` | northstar/image-lite | ∅ (no match) | northstar/image-lite | ✗ | ✓ | image + attachment cues; no name overlap |
| Q10 | `tool` | northstar/alpha-chat | northstar/unknown-tools | northstar/alpha-chat | ✗ | ✓ | substring alone top-1s the Unknown Tools listing; tool_call cue should prefer Alpha Chat |
| Q11 | `structured output` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | ✗ | ✓ | structured_output cue; only Alpha Chat has it true |
| Q12 | `json` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | ✗ | ✓ | shorthand for structured output |
| Q13 | `chat with tools` | northstar/alpha-chat | ∅ (no match) | northstar/alpha-chat | ✗ | ✓ | natural phrasing; whole-string substring matches nothing |
| Q14 | `vision` | northstar/image-lite | ∅ (no match) | northstar/image-lite | ✗ | ✓ | image-modality synonym; matches no name |
| Q15 | `unknown` | northstar/unknown-tools | northstar/unknown-tools | northstar/unknown-tools | ✓ | ✓ | name fragment; no cue words involved |
| Q16 | `orbit` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | provider on the allowlist but absent from stub listings; honest no-match |
| Q17 | `zzz-no-such-listing` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | mirrors the S8 empty-state probe; no-match |
| Q18 | `` | northstar/alpha-chat | northstar/alpha-chat | northstar/alpha-chat | ✓ | ✓ | blank query means no text filtering (S3); stub order first |
| Q19 | `reasoning model` | ∅ (no match) | ∅ (no match) | ∅ (no match) | ✓ | ✓ | reasoning cue matches no listing (Alpha/Image false, Unknown null); honest no-match |
| Q20 | `attach an image` | northstar/image-lite | ∅ (no match) | northstar/image-lite | ✗ | ✓ | attachment + image cues; only Image Lite satisfies both |

**Summary: before 12/20, after 20/20 — 8 fixed, 0 regressed.**

Reproducibility: `node bin/eval-wayselect-search-prompts --seed 5492` (stdlib only,
no network). Determinism self-check passed: both versions are repeatable, and
v2 top-1s on non-blank queries are shuffle-invariant with seed 5492 (S7
stub-order tie-breaks). v1 multi-matches preserve caller order by design (the
server always feeds canonical stub order, so production top-1s reproduce);
blank queries (S3) preserve caller order in both versions.
Content hashes — queries.json `ce37a2488591`, v1-baseline.md `40a0ecdadde2`,
v2-cue-extraction.md `0a1b7b2bbcc0`. Run time 0.0s (budget 90 run-min).
