// Tests for the TOG-7278 gateway probes in the staging smoke
// (support/gateway-smoke-probes.js via bin/smoke-wayselect-staging-preview).
//
// The real handler passes every probe; injected regressions (401 bypass,
// 401 oracle, auto-route refusal, missing dry-run label) must each fail a
// named probe so the smoke fails loud.

import test from "node:test";
import assert from "node:assert/strict";
import { handleChatCompletionsRequest } from "../src/index.js";
import { runGatewayProbes } from "../support/gateway-smoke-probes.js";

const IDS = ["G1", "G1b", "G1c", "G2", "G2b", "G2c"];

function failing(probes) {
  return probes.filter((probe) => !probe.ok).map((probe) => probe.id);
}

test("real gateway handler passes every probe", async () => {
  const probes = await runGatewayProbes();
  assert.deepEqual(probes.map((probe) => probe.id), IDS);
  assert.deepEqual(failing(probes), [], JSON.stringify(probes, null, 2));
});

test("auth bypass (any key accepted) fails G1/G1b/G1c", async () => {
  const handle = (input) =>
    handleChatCompletionsRequest({
      ...input,
      headers: { authorization: `Bearer ${input.gatewayKey}` },
    });
  const failed = failing(await runGatewayProbes({ handle }));
  for (const id of ["G1", "G1b", "G1c"]) {
    assert.ok(failed.includes(id), `expected ${id} to fail, got ${failed}`);
  }
});

test("credential oracle (wrong key distinguishable) fails G1b", async () => {
  const handle = async (input) => {
    const result = await handleChatCompletionsRequest(input);
    if (result.httpStatus === 401 && input.headers?.authorization) {
      return { ...result, headers: { ...result.headers, "X-Key-Present": "1" } };
    }
    return result;
  };
  assert.deepEqual(failing(await runGatewayProbes({ handle })), ["G1b"]);
});

test("auto-route regression (400 instead of routing) fails G2/G2b/G2c", async () => {
  const handle = (input) =>
    handleChatCompletionsRequest({ ...input, candidates: [] });
  const failed = failing(await runGatewayProbes({ handle }));
  for (const id of ["G2", "G2b", "G2c"]) {
    assert.ok(failed.includes(id), `expected ${id} to fail, got ${failed}`);
  }
  assert.ok(!failed.includes("G1"), "401 probes stay green");
});

test("dropped dry-run label fails G2b only", async () => {
  const handle = async (input) => {
    const result = await handleChatCompletionsRequest(input);
    if (result.httpStatus !== 200) {
      return result;
    }
    return {
      ...result,
      body: { ...result.body, wayselect: { ...result.body.wayselect, dryRun: false } },
    };
  };
  assert.deepEqual(failing(await runGatewayProbes({ handle })), ["G2b"]);
});
