import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STUB_LISTINGS } from "../web/stub-listing.js";
import {
  interpretV2,
  rankV1,
  rankV2,
  routeId,
  top1,
} from "../support/search-prompts.js";

const EVAL_DIR = new URL("../evals/search-prompt-regression/", import.meta.url);

async function loadQueries() {
  const raw = await readFile(new URL("queries.json", EVAL_DIR), "utf8");
  return JSON.parse(raw);
}

test("eval fixture holds 20 fixed queries with golden top-1s", async () => {
  const queries = await loadQueries();
  assert.equal(queries.length, 20);
  const ids = queries.map((q) => q.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(new Set(ids).size, 20);
  for (const q of queries) {
    assert.equal(typeof q.query, "string");
    assert.ok(q.expectedTop1 === null || typeof q.expectedTop1 === "string");
  }
});

test("v2 reproduces every golden top-1; v1 matches the recorded baseline", async () => {
  const queries = await loadQueries();
  let beforeHits = 0;
  for (const { id, query, expectedTop1 } of queries) {
    const after = routeId(top1(rankV2(STUB_LISTINGS, query)));
    assert.equal(after, expectedTop1, `v2 ${id} top-1`);
    const before = routeId(top1(rankV1(STUB_LISTINGS, query)));
    if (before === expectedTop1) {
      beforeHits += 1;
    }
  }
  assert.equal(beforeHits, 12);
});

test("cue extraction is fail-closed on unknown capability data", () => {
  // Unknown Tools carries no boolean tool_call: a tool_call cue must exclude
  // it, never guess it eligible. v1 (raw substring) cannot do this.
  const unknownTools = STUB_LISTINGS.find((l) => l.modelId === "unknown-tools");
  assert.ok(unknownTools);
  assert.equal(routeId(top1(rankV1(STUB_LISTINGS, "tool"))), "northstar/unknown-tools");
  assert.equal(routeId(top1(rankV2(STUB_LISTINGS, "tool"))), "northstar/alpha-chat");
  assert.deepEqual(interpretV2("chat with tools").requiredCapabilities, ["tool_call"]);
});

test("both versions are repeatable and v2 is shuffle-invariant (seed 5492)", async () => {
  const queries = await loadQueries();
  const reversed = [...STUB_LISTINGS].reverse();
  for (const { id, query } of queries) {
    for (const rank of [rankV1, rankV2]) {
      const a = JSON.stringify(rank(STUB_LISTINGS, query).map(routeId));
      const b = JSON.stringify(rank(STUB_LISTINGS, query).map(routeId));
      assert.equal(a, b, `repeatable ${id}`);
    }
    if (query.trim() === "") {
      continue; // S3 blank queries preserve caller order by design
    }
    assert.equal(
      routeId(top1(rankV2(STUB_LISTINGS, query))),
      routeId(top1(rankV2(reversed, query))),
      `v2 shuffle-invariant ${id}`,
    );
  }
});
