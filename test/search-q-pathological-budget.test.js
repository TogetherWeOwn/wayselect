// Search-q pathological-input perf audit (TOG-7305).
//
// Gap: the `q` filter path (`parseListingsQuery` + `applyListingsFilters` in
// web/filter.js, plus the eval-only `tokenize` in support/search-prompts.js)
// had no pin against pathological input — long repeats and unicode-class
// values that classically trigger ReDoS/backtracking in regex-based
// matchers. This file feeds such values to the real filter path and asserts
// the whole batch completes within a wall-clock budget.
//
// Audit finding (pinned here, not just described): the `q` path uses literal
// `String.prototype.includes` — no `RegExp` is built from `q` anywhere in
// web/filter.js, web/server.js, or web/listing-detail.js — and `q` is capped
// at LISTINGS_MAX_QUERY_LENGTH (200, fail-closed 400 upstream). The only
// regex touching raw query text is the linear negated-class split
// `/[^a-z0-9]+/` in support/search-prompts.js `tokenize`, which has no
// nested quantifiers and cannot backtrack superlinearly. So this is a
// test-only audit pin: no source fix needed.
//
// What: every pathological `q` at exactly the 200-char bound runs through
// `parseListingsQuery` (must be ok:true), `applyListingsFilters` over a
// 100-row synthetic catalog (max-limit shape, TOG-6380), and `rankV3`
// (tokenize path), with a fixed 300ms control delay, asserting the batch
// stays under SEARCH_Q_PATHOLOGICAL_BUDGET_MS (2000ms). A live-route smoke
// pins GET /listings?q=<200x'a'> to 200 on the stub catalog.
//
// Verifiability: halve the budget to 250ms locally and rerun — the fixed
// 300ms control delay alone exceeds it, so the assertion fails loudly. Feed
// a superlinear matcher (e.g. a backtracking RegExp built from `q`) into
// the same corpus and the batch blows past the budget the same way.
//
// Runbook (when this trips): the filter path grew a regex or a nested loop
// over `q` — bisect recent web/filter.js / web/server.js /
// web/listing-detail.js / support/search-prompts.js changes, profile
// `applyListingsFilters` on the corpus below, fix the regression (restore a
// literal matcher, keep the length bound) — do NOT raise the budget without
// a recorded perf explanation on the card.
//
// node:test, zero dependencies. Localhost only (CONTRIBUTING.md: server
// tests bind an ephemeral port on 127.0.0.1). Test/CI-only, no prod
// activation.

import test from "node:test";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  LISTINGS_MAX_QUERY_LENGTH,
  applyListingsFilters,
  parseListingsQuery,
} from "../web/filter.js";
import { createApp } from "../web/server.js";
import { rankV3 } from "../support/search-prompts.js";

// Batch wall-clock budget: generous vs the measured few-ms batch (the
// corpus is ~20 queries x 100 rows of literal `includes`), but tight
// enough that a superlinear matcher fails loudly. The fixed control delay
// below proves the assertion is wired up (see header).
export const SEARCH_Q_PATHOLOGICAL_BUDGET_MS = 2000;

// Fixed control delay: proves the budget assertion trips (see header). Do
// NOT scale this with the budget — halving the budget must fail loudly.
const CONTROL_DELAY_MS = 300;

// Corpus: every entry is exactly LISTINGS_MAX_QUERY_LENGTH UTF-16 code
// units long (so `parseListingsQuery` takes the ok:true path) and shaped
// like a classic regex-breaker — treated literally by the filter.
function pathologicalQueries() {
  const N = LISTINGS_MAX_QUERY_LENGTH;
  assert.equal(N, 200);
  const greek = "α";
  const cjk = "中";
  const arabic = "م";
  const emoji = "😀"; // one emoji = 2 UTF-16 units
  const combining = "é"; // e + U+0301 = 2 units
  return [
    ["long-repeat", "a".repeat(N)],
    ["long-repeat-near-miss", `${"a".repeat(N - 1)}b`],
    ["alternation-repeat", "ab".repeat(N / 2)],
    ["regex-literal-group", `(a+)${"+$"}${"a".repeat(N - 6)}`.slice(0, N)],
    ["star-run", "a*".repeat(N / 2)],
    ["dot-star-run", ".*".repeat(N / 2)],
    ["alt-pipe-run", "(a|aa)+".repeat(Math.ceil(N / 7)).slice(0, N)],
    ["backtrack-tail", `${"a".repeat(N - 1)}!`],
    ["greek-class", greek.repeat(N)],
    ["cjk-class", cjk.repeat(N)],
    ["arabic-class", arabic.repeat(N)],
    ["emoji-class", emoji.repeat(N / 2)],
    ["combining-class", combining.repeat(N / 2)],
    ["sharp-s-class", "ß".repeat(N)],
    ["turkish-dotted-I", "İ".repeat(N)],
    ["mixed-scripts", `a${greek}${cjk}${emoji}`.repeat(40)],
    ["whitespace-padded", `  ${"a".repeat(N - 4)}  `],
    ["tab-newline-mix", `a\tb\nc`.repeat(40)],
    ["numeric-class", "0".repeat(N)],
    ["punct-class", "!@#$%^&*()".repeat(20)],
  ];
}

// Max-limit-shaped synthetic catalog (TOG-6380 shape): 100 rows with long
// display names so the batch exercises the filter over a full page.
function maxLimitCatalog() {
  return Array.from({ length: 100 }, (_, i) => ({
    providerId: "synth-provider-with-a-long-name",
    providerName: "Synthetic Provider With A Reasonably Long Display Name",
    modelId: `model-${String(i).padStart(3, "0")}`,
    entry: {
      id: `model-${i}`,
      name: `Model Number ${i} With A Fairly Long Display Name For Realism`,
      attachment: true,
      reasoning: false,
      tool_call: true,
      structured_output: false,
      modalities: { input: ["text", "image"], output: ["text"] },
      cost: { input: 1.5, output: 3 },
    },
  }));
}

function paramsFor(q) {
  return new URL(`http://localhost/listings?q=${encodeURIComponent(q)}`).searchParams;
}

describe("search-q pathological-input perf audit (TOG-7305)", () => {
  it("pins the q bound the corpus is built against", () => {
    assert.equal(LISTINGS_MAX_QUERY_LENGTH, 200);
    for (const [label, q] of pathologicalQueries()) {
      assert.equal(
        q.length,
        LISTINGS_MAX_QUERY_LENGTH,
        `corpus entry ${label} must sit exactly at the bound`,
      );
    }
  });

  it("parseListingsQuery accepts every pathological q at the bound", () => {
    for (const [label, q] of pathologicalQueries()) {
      const parsed = parseListingsQuery(paramsFor(q));
      assert.equal(parsed.ok, true, `pathological q ${label} must parse ok`);
      assert.equal(parsed.filters.q, q);
    }
  });

  it(`filter + rank batch with ${CONTROL_DELAY_MS}ms control delay completes within ${SEARCH_Q_PATHOLOGICAL_BUDGET_MS}ms`, async () => {
    const catalog = maxLimitCatalog();
    const corpus = pathologicalQueries();
    assert.ok(corpus.length >= 15, `corpus must hold the acceptance floor (got ${corpus.length})`);

    const start = process.hrtime.bigint();
    await new Promise((resolve) => setTimeout(resolve, CONTROL_DELAY_MS));
    for (const [label, q] of corpus) {
      const matched = applyListingsFilters(catalog, { q, capabilities: [], modalities: [] });
      assert.ok(Array.isArray(matched), `filter returns a list for ${label}`);
      // Corpus values match nothing (or at most the full page on blank —
      // never more than the catalog): the pin is completion, not ranking.
      assert.ok(
        matched.length <= catalog.length,
        `filter output bounded for ${label}`,
      );
      const ranked = rankV3(catalog, q);
      assert.ok(Array.isArray(ranked), `rank returns a list for ${label}`);
      assert.ok(ranked.length <= catalog.length, `rank output bounded for ${label}`);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.ok(
      elapsedMs < SEARCH_Q_PATHOLOGICAL_BUDGET_MS,
      `Search-q perf regression: pathological batch took ${elapsedMs.toFixed(1)}ms, ` +
        `budget ${SEARCH_Q_PATHOLOGICAL_BUDGET_MS}ms. Runbook: bisect ` +
        `recent web/filter.js / web/server.js / web/listing-detail.js / ` +
        `support/search-prompts.js changes for a regex (or nested loop) ` +
        `built over q, profile applyListingsFilters on the corpus in this ` +
        `file — do not raise the budget without a recorded perf explanation.`,
    );
  });

  it("literal regex metacharacters match nothing and never throw", () => {
    const catalog = maxLimitCatalog();
    for (const q of ["(a+)+$", ".*", "(a|aa)+b", "a*b*c*"]) {
      const matched = applyListingsFilters(catalog, { q, capabilities: [], modalities: [] });
      assert.equal(matched.length, 0, `literal ${q} must not match long-name rows`);
    }
  });
});

describe("pathological-q server route (TOG-7305)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves a max-bound repeat q with a 200 and an empty result", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?q=${encodeURIComponent("a".repeat(200))}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("No listings match these filters."), "repeat q yields the empty state");
  });
});
