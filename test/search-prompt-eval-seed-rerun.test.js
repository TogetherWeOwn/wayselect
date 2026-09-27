import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

// Tests for TOG-6047: search-prompt eval seed-rerun contract (round-2 gap T4).
//
// The eval (`bin/eval-wayselect-search-prompts`) ran pinned to a seed nobody
// documented. These tests assert the documented seed matches the script
// default, the npm script, and the recorded results — and that a reviewer
// following the doc reproduces the recorded SUMMARY. Contract doc:
// docs/search-prompt-eval-seed-rerun.md.

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const DOC_URL = new URL("../docs/search-prompt-eval-seed-rerun.md", import.meta.url);
const EVAL_URL = new URL("../bin/eval-wayselect-search-prompts", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const RESULTS_URL = new URL("../evals/search-prompt-regression/results.md", import.meta.url);

// Same baselines as search-prompt-regression and the multi-seed pin: a seed
// that moves them fails here, not silently in results.md.
const EXPECTED_SUMMARY =
  "SUMMARY: before 13/30, mid 24/30, after 30/30, v2-fixed 11, v3-fixed 6, regressed 0";

async function documentedSeed() {
  const doc = await readFile(DOC_URL, "utf8");
  const match = doc.match(/^Documented seed: `(\d+)`$/m);
  assert.ok(match, "doc pins the seed on a `Documented seed: `<n>`` line");
  return Number.parseInt(match[1], 10);
}

test("TOG-6047: documented seed matches the eval script default", async () => {
  const seed = await documentedSeed();
  const source = await readFile(EVAL_URL, "utf8");
  const def = source.match(/\?\s*(\d+)\s*:\s*Number\.parseInt/);
  assert.ok(def, "eval script has a literal default seed");
  assert.equal(Number.parseInt(def[1], 10), seed, "doc seed matches script default");
});

test("TOG-6047: documented seed matches the npm script and the recorded results", async () => {
  const seed = await documentedSeed();
  const pkg = JSON.parse(await readFile(PACKAGE_URL, "utf8"));
  assert.ok(
    pkg.scripts["eval:search-prompts"].includes(`--seed ${seed}`),
    "npm eval:search-prompts carries the documented seed",
  );
  const results = await readFile(RESULTS_URL, "utf8");
  assert.ok(
    results.includes(`--seed ${seed}`),
    "results.md records the documented seed",
  );
});

test("TOG-6047: default and explicit-seed reruns reproduce the recorded SUMMARY", async () => {
  const seed = await documentedSeed();
  const summaries = [];
  for (const args of [[], ["--seed", String(seed)]]) {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/eval-wayselect-search-prompts", ...args],
      { cwd: repoRoot },
    );
    const line = stdout.trim().split("\n").find((l) => l.startsWith("SUMMARY:"));
    assert.ok(line, "eval prints a SUMMARY line");
    summaries.push(line.replace(/ — \d+\.\d+s$/, ""));
  }
  assert.equal(summaries[0], summaries[1], "default run matches explicit-seed run");
  assert.equal(summaries[0], EXPECTED_SUMMARY, "rerun reproduces the recorded result");
});
