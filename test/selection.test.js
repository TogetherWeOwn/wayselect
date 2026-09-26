import test from "node:test";
import assert from "node:assert/strict";
import { selectRoute } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const request = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

test("selects deterministically and uses route id as the stable rate tie-break", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const forward = selectRoute(candidates, request, evaluationOptions);
  const reverse = selectRoute([...candidates].reverse(), request, evaluationOptions);

  assert.equal(forward.status, "selected");
  assert.equal(forward.selected.routeId, "northstar/alpha-chat");
  assert.deepEqual(reverse, forward);
  assert.equal(
    forward.policy,
    "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
  );
  assert.match(forward.rateDisclaimer, /not actual cost or savings/);
});

test("returns an explained no-eligible-route result", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const result = selectRoute(
    candidates,
    {
      operation: "chat",
      requiredCapabilities: ["reasoning"],
      providerAllowlist: ["northstar"],
    },
    evaluationOptions,
  );

  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.selected, null);
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every((candidate) => candidate.eligible === false));
});
