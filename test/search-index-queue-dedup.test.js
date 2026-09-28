// Search-index queue dedup under concurrency (TOG-7299).
//
// TOG-5460 pinned sequential dedup: enqueueing an identical pending request
// returns the existing job (deduped:true). This file pins the concurrent
// side of the same contract against `createRefreshQueue` in
// `src/searchIndex.js` (test-only, no source change):
//
//   1. Single-flight on identical input: N overlapping enqueue calls with the
//      same catalog body + provenance stamp collapse to one pending job; every
//      duplicate reports deduped:true with the first jobId, and drain emits
//      exactly one result.
//   2. Distinct refreshes stay consistent: different catalog bodies drain in
//      FIFO order, each result hash matches an independent build, and the
//      queue's current index ends on the last drained result.
//   3. No over-dedup: the same body re-stamped at a new time is a distinct
//      job, and enqueue-clock skew alone never breaks single-flight.
//
// node:test, stdlib only. Fixture-only: no network, no credentials, no
// production writes. The evaluation clock follows the suite-wide
// snapshot-derived pattern in support/helpers.js.

import test from "node:test";
import assert from "node:assert/strict";
import { computeCatalogSnapshotHash } from "../src/catalog.js";
import { buildSearchIndex, createRefreshQueue } from "../src/searchIndex.js";
import { evaluationNow, readFixture } from "../support/helpers.js";

const NOW = evaluationNow().toISOString();

async function fixtureParts() {
  const fixture = await readFixture("catalog.synthetic.json");
  return { catalog: fixture.catalog, provenance: fixture.provenance };
}

function withExtraModel(catalog, provenance) {
  const next = structuredClone(catalog);
  next.orbit.models["orbit-next"] = {
    id: "orbit-next",
    name: "Orbit Next",
    attachment: false,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 1, output: 1 },
  };
  return {
    catalog: next,
    provenance: {
      ...provenance,
      snapshotTimestamp: new Date(
        Date.parse(provenance.snapshotTimestamp) + 60 * 60 * 1000,
      ).toISOString(),
      snapshotHash: computeCatalogSnapshotHash(next),
    },
  };
}

test("TOG-7299: concurrent identical enqueues single-flight to one pending job", async () => {
  const { catalog, provenance } = await fixtureParts();
  const queue = createRefreshQueue();

  // Overlapping refreshes: interleave the enqueues across microtasks the way
  // concurrent callers would arrive, then join them all.
  const attempts = await Promise.all(
    Array.from({ length: 8 }, async (_slot, index) => {
      await Promise.resolve();
      // Clock skew across callers must not break single-flight: the queue key
      // is body hash + provenance stamp, not enqueue time.
      const now = new Date(Date.parse(NOW) + index * 1000).toISOString();
      return queue.enqueue(catalog, provenance, { now });
    }),
  );

  const [first, ...rest] = attempts;
  assert.equal(first.deduped, false);
  for (const duplicate of rest) {
    assert.equal(duplicate.deduped, true);
    assert.equal(duplicate.jobId, first.jobId);
  }
  assert.equal(queue.pendingCount(), 1);

  const results = queue.drain();
  assert.equal(results.length, 1);
  assert.equal(results[0].jobId, first.jobId);
  assert.equal(results[0].routeCount, 6);
  assert.equal(queue.pendingCount(), 0);
});

test("TOG-7299: concurrent distinct refreshes drain in order and stay consistent", async () => {
  const { catalog, provenance } = await fixtureParts();
  const moved = withExtraModel(catalog, provenance);
  const queue = createRefreshQueue();
  const options = { now: NOW };

  const [baseJob, movedJob] = await Promise.all([
    (async () => {
      await Promise.resolve();
      return queue.enqueue(catalog, provenance, options);
    })(),
    (async () => {
      await Promise.resolve();
      return queue.enqueue(moved.catalog, moved.provenance, options);
    })(),
  ]);
  assert.equal(baseJob.deduped, false);
  assert.equal(movedJob.deduped, false);
  assert.notEqual(movedJob.jobId, baseJob.jobId);
  assert.equal(queue.pendingCount(), 2);

  const results = queue.drain();
  assert.equal(results.length, 2);
  // FIFO: the base refresh drains before the moved one.
  assert.equal(results[0].jobId, baseJob.jobId);
  assert.equal(results[1].jobId, movedJob.jobId);

  // Each drained refresh agrees with an independent build of the same input.
  // (The first-job result carries no contentHash field — drain only reports
  // it from the reload path — so the base hash is proven through the second
  // result's previousContentHash and the settled current index instead.)
  const expectedBase = buildSearchIndex(catalog, provenance, options);
  const expectedMoved = buildSearchIndex(moved.catalog, moved.provenance, options);
  assert.equal(results[0].changed, true);
  assert.equal(results[0].previousContentHash, null);
  assert.equal(results[0].routeCount, 6);
  assert.equal(results[1].contentHash, expectedMoved.contentHash);
  assert.equal(results[1].changed, true);
  assert.equal(results[1].previousContentHash, expectedBase.contentHash);
  assert.equal(results[1].routeCount, 7);

  // The queue settles on the last drained index.
  assert.equal(queue.currentIndex().contentHash, expectedMoved.contentHash);
  assert.equal(queue.pendingCount(), 0);
});

test("TOG-7299: same body re-stamped is a distinct job, not a duplicate", async () => {
  const { catalog, provenance } = await fixtureParts();
  const queue = createRefreshQueue();

  const restamped = {
    ...provenance,
    snapshotTimestamp: new Date(
      Date.parse(provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000,
    ).toISOString(),
  };
  const first = queue.enqueue(catalog, provenance, { now: NOW });
  const second = queue.enqueue(catalog, restamped, { now: NOW });
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, false);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(queue.pendingCount(), 2);

  const results = queue.drain();
  assert.equal(results.length, 2);
  // Same body re-stamped: the second drain is a no-op reload against the
  // first (changed:false), proven through the reload-path hash fields.
  const expected = buildSearchIndex(catalog, provenance, { now: NOW });
  assert.equal(results[1].changed, false);
  assert.equal(results[1].previousContentHash, expected.contentHash);
  assert.equal(results[1].contentHash, expected.contentHash);
  assert.equal(queue.currentIndex().contentHash, expected.contentHash);
});
