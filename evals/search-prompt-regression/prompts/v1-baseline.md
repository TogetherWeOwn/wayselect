# v1-baseline (before): raw substring pass-through

The storefront search box forwards the buyer's raw text unchanged to the
listing index, which applies the shipped S2 rule from
`docs/wayselect-web-acceptance.md`:

> `?q=<text>` — case-insensitive substring match against `entry.name`,
> route `providerId/modelId`, and `providerName`. Blank means no filtering (S3).

No synonyms, no cue extraction, no re-ranking. Stub order is preserved (S7).

This prompt version is the "before" column in the TOG-5492 regression eval.
It is intentionally weak on natural phrasing ("chat with tools", "picture")
so the eval can measure what the v2 cue-extraction prompt recovers.
