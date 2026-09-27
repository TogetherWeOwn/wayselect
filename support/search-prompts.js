// Search-prompt ranking versions for the TOG-5492 regression eval.
//
// Pure functions of (query, listings) over the stub listing shape in
// web/stub-listing.js. No network, no credentials, no randomness.
//
//   rankV1 — baseline: raw substring pass-through (shipped S2 rule from
//            docs/wayselect-web-acceptance.md). Preserves caller input
//            order, so multi-match top-1s are input-order-dependent by
//            design; production is reproducible because the server always
//            feeds canonical stub order.
//   rankV2 — interpret-then-match (evals/search-prompt-regression/prompts/
//            v2-cue-extraction.md). Ties break on canonical stub order
//            (S7), never on caller input order, so top-1s are
//            input-order-independent for non-blank queries. Blank queries
//            (S3) pass input order through in both versions.
//   rankV3 — v2 plus negation scope (prompts/v3-negation-scope.md): cue
//            words after a negation marker become exclusions instead of
//            requirements. Exclusions are fail-closed (capability must be
//            explicitly false; unknown/null never proves absence).
//            Queries without markers behave exactly like v2.

import { STUB_LISTINGS } from "../web/stub-listing.js";

function haystack(listing) {
  return `${listing.entry.name} ${listing.providerId}/${listing.modelId} ${listing.providerName}`.toLowerCase();
}

export function top1(ranked) {
  return ranked.length > 0 ? ranked[0] : null;
}

export function routeId(listing) {
  return listing ? `${listing.providerId}/${listing.modelId}` : null;
}

// Canonical S7 order: the stub array order the server feeds the index.
// Unknown routes fall back to the end, in lexicographic order.
const STUB_ORDER = new Map(STUB_LISTINGS.map((listing, index) => [routeId(listing), index]));

function stubOrderRank(listing) {
  const rank = STUB_ORDER.get(routeId(listing));
  if (rank !== undefined) {
    return [0, rank];
  }
  return [1, routeId(listing) ?? ""];
}

function compareStubOrder(a, b) {
  const [aGroup, aKey] = stubOrderRank(a);
  const [bGroup, bKey] = stubOrderRank(b);
  if (aGroup !== bGroup) {
    return aGroup - bGroup;
  }
  if (typeof aKey === "number" && typeof bKey === "number") {
    return aKey - bKey;
  }
  return String(aKey) < String(bKey) ? -1 : String(aKey) > String(bKey) ? 1 : 0;
}

export function rankV1(listings, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") {
    return [...listings]; // S3: blank means no text filtering
  }
  return listings.filter((listing) => haystack(listing).includes(q));
}

const CUE_CAPABILITIES = [
  { field: "attachment", words: new Set(["attach", "attachment", "upload", "file", "picture", "photo", "screenshot"]) },
  { field: "tool_call", words: new Set(["tool", "tools", "function", "functions", "api"]) },
  { field: "structured_output", words: new Set(["structured", "json", "schema"]) },
  { field: "reasoning", words: new Set(["reasoning", "reason", "think", "thinking", "cot"]) },
];
const CUE_MODALITIES = {
  image: new Set(["image", "picture", "photo", "vision", "visual", "camera", "screenshot"]),
  chat: new Set(["chat", "conversation", "talk", "message", "chatting"]),
};
const STOPWORDS = new Set([
  "with", "a", "an", "the", "model", "models", "for", "me", "my", "and", "or",
  "to", "of", "in", "on", "that", "can", "do", "does", "need", "want", "looking",
  "find", "show", "give", "get", "no", "not", "none", "never",
]);

// v3 negation markers: open a forward scope — every cue word after the
// marker in the same query is an exclusion instead of a requirement.
const NEGATION_MARKERS = new Set([
  "no", "not", "none", "never", "without", "except", "minus",
  "exclude", "excluding",
]);

function tokenize(rawQuery) {
  return rawQuery.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasChatOperation(listing) {
  const input = listing.entry?.modalities?.input ?? [];
  const output = listing.entry?.modalities?.output ?? [];
  return input.includes("text") && output.includes("text");
}

function hasModality(listing, modality) {
  const input = listing.entry?.modalities?.input ?? [];
  const output = listing.entry?.modalities?.output ?? [];
  return input.includes(modality) || output.includes(modality);
}

export function interpretV2(rawQuery) {
  const words = tokenize(rawQuery);
  const requiredCapabilities = [];
  for (const { field, words: cue } of CUE_CAPABILITIES) {
    if (words.some((w) => cue.has(w))) {
      requiredCapabilities.push(field);
    }
  }
  const requiredModalities = [];
  if (words.some((w) => CUE_MODALITIES.image.has(w))) {
    requiredModalities.push("image");
  }
  if (words.some((w) => CUE_MODALITIES.chat.has(w))) {
    requiredModalities.push("chat");
  }
  const consumed = new Set([
    ...CUE_CAPABILITIES.flatMap(({ words: cue }) => [...cue]),
    ...CUE_MODALITIES.image,
    ...CUE_MODALITIES.chat,
    ...STOPWORDS,
  ]);
  const keywords = words.filter((w) => !consumed.has(w));
  return { requiredCapabilities, requiredModalities, keywords };
}

// Split cue hits into positive requirements vs negated exclusions.
// Queries with no negation marker return empty exclusions and behave
// exactly like v2.
export function interpretV3(rawQuery) {
  const words = tokenize(rawQuery);
  const v2 = interpretV2(rawQuery);
  const markerIndex = words.findIndex((w) => NEGATION_MARKERS.has(w));
  if (markerIndex === -1) {
    return {
      ...v2,
      excludedCapabilities: [],
      excludedModalities: [],
    };
  }
  const before = words.slice(0, markerIndex);
  const after = words.slice(markerIndex + 1);
  const hitBefore = (cue) => before.some((w) => cue.has(w));
  const hitAfter = (cue) => after.some((w) => cue.has(w));
  const requiredCapabilities = [];
  const excludedCapabilities = [];
  for (const { field, words: cue } of CUE_CAPABILITIES) {
    if (hitAfter(cue) && !hitBefore(cue)) {
      excludedCapabilities.push(field);
    } else if (hitBefore(cue) || hitAfter(cue)) {
      // No hits here means v2 found nothing either (marker-only scope
      // like "zzz-no-such-listing"); positive mention anywhere wins.
      if (v2.requiredCapabilities.includes(field)) {
        requiredCapabilities.push(field);
      }
    }
  }
  const requiredModalities = [];
  const excludedModalities = [];
  for (const [modality, cue] of [["image", CUE_MODALITIES.image], ["chat", CUE_MODALITIES.chat]]) {
    const key = modality === "chat" ? "chat" : modality;
    if (hitAfter(cue) && !hitBefore(cue)) {
      excludedModalities.push(key);
    } else if (v2.requiredModalities.includes(key)) {
      requiredModalities.push(key);
    }
  }
  const consumed = new Set([...NEGATION_MARKERS]);
  const keywords = v2.keywords.filter((w) => !consumed.has(w));
  return { requiredCapabilities, excludedCapabilities, requiredModalities, excludedModalities, keywords };
}

function excludedCapabilityFailsClosed(listing, field) {
  // Only an explicit false proves absence; true, null, or missing
  // excludes the listing (never guess that unknown means absent).
  return listing.entry?.[field] !== false;
}

function excludedModalityFailsClosed(listing, modality) {
  if (modality === "chat") {
    return hasChatOperation(listing);
  }
  return hasModality(listing, modality);
}

export function rankV2(listings, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") {
    return [...listings]; // S3: blank means no text filtering
  }
  const { requiredCapabilities, requiredModalities, keywords } = interpretV2(rawQuery);
  const survivors = listings.filter((listing) => {
    for (const field of requiredCapabilities) {
      if (listing.entry?.[field] !== true) {
        return false; // fail closed: false, null, or missing excludes
      }
    }
    for (const modality of requiredModalities) {
      if (modality === "chat" ? !hasChatOperation(listing) : !hasModality(listing, modality)) {
        return false;
      }
    }
    return true;
  });
  const scored = [];
  for (const listing of survivors) {
    const hay = haystack(listing);
    let score = 0;
    if (hay.includes(q)) {
      score += 2;
    }
    for (const keyword of keywords) {
      if (hay.includes(keyword)) {
        score += 1;
      }
    }
    // Survivors matched every required cue, so the cue match itself is a
    // relevance signal: keep them even when keywords score nothing (the
    // keywords only add ranking). Filters that match nothing still yield
    // no survivors, so the honest no-match path is preserved.
    const cuesExtracted = requiredCapabilities.length + requiredModalities.length > 0;
    if (score > 0 || keywords.length === 0 || cuesExtracted) {
      scored.push({ listing, score });
    }
  }
  scored.sort(
    (a, b) => b.score - a.score || compareStubOrder(a.listing, b.listing),
  );
  return scored.map(({ listing }) => listing);
}

export function rankV3(listings, rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  if (q === "") {
    return [...listings]; // S3: blank means no text filtering
  }
  const {
    requiredCapabilities, excludedCapabilities,
    requiredModalities, excludedModalities, keywords,
  } = interpretV3(rawQuery);
  const survivors = listings.filter((listing) => {
    for (const field of requiredCapabilities) {
      if (listing.entry?.[field] !== true) {
        return false; // fail closed: false, null, or missing excludes
      }
    }
    for (const modality of requiredModalities) {
      if (modality === "chat" ? !hasChatOperation(listing) : !hasModality(listing, modality)) {
        return false;
      }
    }
    for (const field of excludedCapabilities) {
      if (excludedCapabilityFailsClosed(listing, field)) {
        return false; // fail closed: only explicit false proves absence
      }
    }
    for (const modality of excludedModalities) {
      if (excludedModalityFailsClosed(listing, modality)) {
        return false;
      }
    }
    return true;
  });
  const scored = [];
  for (const listing of survivors) {
    const hay = haystack(listing);
    let score = 0;
    if (hay.includes(q)) {
      score += 2;
    }
    for (const keyword of keywords) {
      if (hay.includes(keyword)) {
        score += 1;
      }
    }
    const cuesExtracted =
      requiredCapabilities.length + requiredModalities.length +
      excludedCapabilities.length + excludedModalities.length > 0;
    if (score > 0 || keywords.length === 0 || cuesExtracted) {
      scored.push({ listing, score });
    }
  }
  scored.sort(
    (a, b) => b.score - a.score || compareStubOrder(a.listing, b.listing),
  );
  return scored.map(({ listing }) => listing);
}
