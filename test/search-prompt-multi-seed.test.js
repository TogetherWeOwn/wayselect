import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { STUB_LISTINGS } from "../web/stub-listing.js";
import {
  rankV1,
  rankV2,
  rankV3,
  routeId,
  top1,
} from "../support/search-prompts.js";

// Tests for TOG-6381: multi-seed eval stability (round-3 gap T3).
//
// The search-prompt eval (`bin/eval-wayselect-search-prompts --seed 5492`)
// and the regression suite pinned exactly one shuffle of the stub listings,
// so seed-sensitivity of the published numbers was unknown. These tests
// assert the eval outcome is seed-invariant: repeatability, v2/v3
// shuffle-invariance, v3 golden top-1s, and the CLI SUMMARY line are
// identical across one seed per shuffle class.
//
// With 3 stub listings there are exactly 3! = 6 input orderings. The eval's
// shuffle is mulberry32 + Fisher-Yates (replicated below — keep in sync
// with bin/eval-wayselect-search-prompts): STABILITY_SEEDS hits every class
// observed across seeds 0..199, and the coverage test fails if the binary's
// shuffle ever drifts so the list no longer covers all classes.

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const EVAL_DIR = new URL("../evals/search-prompt-regression/", import.meta.url);

// One seed per shuffle class (mapping verified by the coverage test below;
// 5492 is the eval's documented default).
const STABILITY_SEEDS = [0, 1, 2, 5, 10, 5492];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(listings, seed) {
  const rand = mulberry32(seed);
  const copy = [...listings];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const orderingKey = (listings) => listings.map(routeId).join(">");

async function loadQueries() {
  const raw = await readFile(new URL("queries.json", EVAL_DIR), "utf8");
  return JSON.parse(raw);
}

test("stability seeds cover every shuffle class (seeds 0..199)", () => {
  const observed = new Set();
  for (let seed = 0; seed < 200; seed++) {
    observed.add(orderingKey(shuffled(STUB_LISTINGS, seed)));
  }
  assert.equal(observed.size, 6, `3 listings admit 6 orderings, saw ${observed.size}`);
  const covered = new Set(STABILITY_SEEDS.map((s) => orderingKey(shuffled(STUB_LISTINGS, s))));
  for (const ordering of observed) {
    assert.ok(covered.has(ordering), `no stability seed exercises ordering ${ordering}`);
  }
});

test("all versions repeatable, v2/v3 shuffle-invariant, v3 matches goldens — every seed", async () => {
  const queries = await loadQueries();
  // Goldens are defined on canonical stub order (the server always feeds it),
  // so assert them once there; shuffled inputs assert repeatability plus the
  // non-blank shuffle-invariance the eval's self-check proves for seed 5492.
  for (const { id, query, expectedTop1 } of queries) {
    assert.equal(
      routeId(top1(rankV3(STUB_LISTINGS, query))),
      expectedTop1,
      `v3 ${id} golden top-1`,
    );
  }
  for (const seed of STABILITY_SEEDS) {
    const input = shuffled(STUB_LISTINGS, seed);
    for (const { id, query } of queries) {
      for (const [name, rank] of [["v1", rankV1], ["v2", rankV2], ["v3", rankV3]]) {
        const a = JSON.stringify(rank(input, query).map(routeId));
        const b = JSON.stringify(rank(input, query).map(routeId));
        assert.equal(a, b, `seed ${seed}: ${name} ${id} repeatable`);
      }
      if (query.trim() === "") {
        continue; // S3 blank queries preserve caller order by design
      }
      for (const [name, rank] of [["v2", rankV2], ["v3", rankV3]]) {
        assert.equal(
          routeId(top1(rank(input, query))),
          routeId(top1(rank(STUB_LISTINGS, query))),
          `seed ${seed}: ${name} ${id} shuffle-invariant`,
        );
      }
    }
  }
});

test("CLI SUMMARY identical across stability seeds (seed-sensitivity known)", async () => {
  const summaries = [];
  for (const seed of STABILITY_SEEDS) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/eval-wayselect-search-prompts", "--seed", String(seed)],
      { cwd: repoRoot },
    );
    const line = stdout.trim().split("\n").find((l) => l.startsWith("SUMMARY:"));
    assert.ok(line, `seed ${seed}: eval prints a SUMMARY line`);
    summaries.push(line.replace(/ — \d+\.\d+s$/, ""));
  }
  for (const summary of summaries) {
    assert.equal(summary, summaries[0], "eval outcome identical across seeds");
  }
  // Pins the published numbers (same baselines as search-prompt-regression):
  // a seed that moves them fails here, not silently in results.md.
  assert.equal(
    summaries[0],
    "SUMMARY: before 13/30, mid 24/30, after 30/30, v2-fixed 11, v3-fixed 6, regressed 0",
  );
});
