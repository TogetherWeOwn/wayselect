// Tests for TOG-6035: snapshot diff golden-output pins.
//
// `snapshots/sample-diff-with-changes.md` and
// `snapshots/diff-report-consecutive-green.md` ship as golden files with no
// pin test, so diff regressions land silently. These tests regenerate both
// reports from the checked-in snapshot inputs and assert byte-identical
// output: any cosmetic edit to a golden file or its input fixtures fails
// loudly here.
//
// The with-changes current snapshot is derived from the stored previous
// snapshot (remove legacy/old-chat, add orbit/orbit-next, rename
// northstar/alpha-chat) with its content hash recomputed via
// computeContentHash, so the test stays green across fixture refreshes and
// never depends on wall-clock stamps.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diffSnapshots, formatDiffReport } from "../src/catalogDiff.js";
import { computeContentHash } from "../src/snapshot.js";

async function readSnapshot(name) {
  const raw = await readFile(new URL(`../snapshots/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

async function readGolden(name) {
  return readFile(new URL(`../snapshots/${name}`, import.meta.url), "utf8");
}

function buildChangedCurrent(previous) {
  const current = structuredClone(previous);
  current.entries = current.entries.filter((entry) => entry.routeId !== "legacy/old-chat");
  for (const entry of current.entries) {
    if (entry.routeId === "northstar/alpha-chat") {
      entry.name = "Alpha Chat v2";
    }
  }
  current.entries.push({
    routeId: "orbit/orbit-next",
    providerId: "orbit",
    modelId: "orbit-next",
    name: "Orbit Next",
    catalogOperations: ["chat"],
    capabilities: {
      attachment: false,
      reasoning: true,
      toolUse: true,
      structuredOutput: true,
      imageInput: false,
      textInput: true,
      textOutput: true,
    },
    rates: { inputPerMillion: 1, outputPerMillion: 1 },
  });
  current.entries.sort((left, right) => (left.routeId < right.routeId ? -1 : 1));
  current.contentHash = computeContentHash(current.entries);
  return current;
}

test("TOG-6035: consecutive-green diff regenerates byte-identically", async () => {
  const previous = await readSnapshot("snapshot-20260924T120000000Z-c6cdb62e.json");
  const current = await readSnapshot("snapshot-20260924T120500000Z-c6cdb62e.json");
  const golden = await readGolden("diff-report-consecutive-green.md");

  const regenerated = formatDiffReport(diffSnapshots(previous, current));
  assert.equal(regenerated, golden, "consecutive-green diff must match the golden file byte-for-byte");
});

test("TOG-6035: sample diff with changes regenerates byte-identically", async () => {
  const previous = await readSnapshot("snapshot-20260924T120000000Z-c6cdb62e.json");
  const golden = await readGolden("sample-diff-with-changes.md");

  const current = buildChangedCurrent(previous);
  assert.equal(
    current.contentHash,
    "sha256:4f1415ef290dc7960e50c6b498cac84e2537744bf70708fb7d55af5077cc9b4a",
    "mutated current snapshot must reproduce the golden current content hash",
  );

  const diff = diffSnapshots(previous, current);
  assert.deepEqual(diff.added, ["orbit/orbit-next"]);
  assert.deepEqual(diff.removed, ["legacy/old-chat"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].routeId, "northstar/alpha-chat");

  const regenerated = formatDiffReport(diff);
  assert.equal(regenerated, golden, "sample diff must match the golden file byte-for-byte");
});
