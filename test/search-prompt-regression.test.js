import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STUB_LISTINGS } from "../web/stub-listing.js";
import {
  interpretV2,
  interpretV3,
  rankV1,
  rankV2,
  rankV3,
  routeId,
  top1,
} from "../support/search-prompts.js";

const EVAL_DIR = new URL("../evals/search-prompt-regression/", import.meta.url);

async function loadQueries() {
  const raw = await readFile(new URL("queries.json", EVAL_DIR), "utf8");
  return JSON.parse(raw);
}

test("eval fixture holds 30 fixed queries with golden top-1s", async () => {
  const queries = await loadQueries();
  assert.equal(queries.length, 30);
  const ids = queries.map((q) => q.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual(new Set(ids).size, 30);
  for (const q of queries) {
    assert.equal(typeof q.query, "string");
    assert.ok(q.expectedTop1 === null || typeof q.expectedTop1 === "string");
  }
});

test("v3 reproduces every golden top-1; v1/v2 match the recorded baselines", async () => {
  const queries = await loadQueries();
  let beforeHits = 0;
  let midHits = 0;
  for (const { id, query, expectedTop1 } of queries) {
    const after = routeId(top1(rankV3(STUB_LISTINGS, query)));
    assert.equal(after, expectedTop1, `v3 ${id} top-1`);
    if (routeId(top1(rankV1(STUB_LISTINGS, query))) === expectedTop1) {
      beforeHits += 1;
    }
    if (routeId(top1(rankV2(STUB_LISTINGS, query))) === expectedTop1) {
      midHits += 1;
    }
  }
  assert.equal(beforeHits, 13);
  assert.equal(midHits, 24);
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

test("negation scope is fail-closed on unknown capability data", () => {
  // "model without tools" must not answer Unknown Tools (tool_call null is
  // not evidence of absence) — only Image Lite (explicitly false) answers.
  // v2 reads the cue as a positive requirement and top-1s Alpha Chat.
  assert.equal(routeId(top1(rankV2(STUB_LISTINGS, "model without tools"))), "northstar/alpha-chat");
  assert.equal(routeId(top1(rankV3(STUB_LISTINGS, "model without tools"))), "northstar/image-lite");
  const interp = interpretV3("model without tools");
  assert.deepEqual(interp.excludedCapabilities, ["tool_call"]);
  // Marker-only scopes like "zzz-no-such-listing" stay honest no-matches.
  assert.deepEqual(interpretV3("zzz-no-such-listing").excludedCapabilities, []);
  assert.equal(routeId(top1(rankV3(STUB_LISTINGS, "zzz-no-such-listing"))), null);
});

test("all versions are repeatable and v2/v3 are shuffle-invariant (seed 5492)", async () => {
  const queries = await loadQueries();
  const reversed = [...STUB_LISTINGS].reverse();
  for (const { id, query } of queries) {
    for (const rank of [rankV1, rankV2, rankV3]) {
      const a = JSON.stringify(rank(STUB_LISTINGS, query).map(routeId));
      const b = JSON.stringify(rank(STUB_LISTINGS, query).map(routeId));
      assert.equal(a, b, `repeatable ${id}`);
    }
    if (query.trim() === "") {
      continue; // S3 blank queries preserve caller order by design
    }
    for (const [name, rank] of [["v2", rankV2], ["v3", rankV3]]) {
      assert.equal(
        routeId(top1(rank(STUB_LISTINGS, query))),
        routeId(top1(rank(reversed, query))),
        `${name} shuffle-invariant ${id}`,
      );
    }
  }
});
