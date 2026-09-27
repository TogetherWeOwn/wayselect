// TOG-5644: route-ID tie-break is locale-independent code-unit order.
//
// `String.prototype.localeCompare` follows the process ICU locale: under
// lt_LT "p/y-chat" sorts before "p/k-chat", while under en_US the order
// flips. The selection policy promises lexicographic route-ID order, so both
// sort sites (the eligibility pre-sort and the selection tie-break) must
// compare UTF-16 code units with `<`/`>` semantics. These tests pin code-unit
// order for a case-mixed pair (`p/B-chat` < `p/a-chat`: 0x42 < 0x61) and an
// i/y/k trio that diverges across locales, and prove no locale-sensitive
// comparison runs at all by failing any `localeCompare` call during selection.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compareRouteIds,
  evaluateEligibility,
  selectRoute,
} from "../src/index.js";
import { evaluationOptions } from "../support/helpers.js";

const REQUEST = Object.freeze({
  operation: "chat",
  requiredCapabilities: [],
  providerAllowlist: ["p"],
});

function tieCandidate(routeId) {
  return {
    routeId,
    providerId: "p",
    modelId: routeId.split("/")[1],
    supportState: "configured",
    catalogOperations: ["chat"],
    configuredOperations: ["chat"],
    capabilities: {},
    rates: { inputPerMillion: 1, outputPerMillion: 2 },
    evidence: { observedAt: "2026-09-26T15:00:00.000Z" },
  };
}

test("compareRouteIds uses UTF-16 code-unit order", () => {
  assert.ok(compareRouteIds("p/B-chat", "p/a-chat") < 0);
  assert.ok(compareRouteIds("p/a-chat", "p/B-chat") > 0);
  assert.ok(compareRouteIds("p/i-chat", "p/y-chat") < 0);
  assert.ok(compareRouteIds("p/k-chat", "p/y-chat") < 0);
  assert.equal(compareRouteIds("p/k-chat", "p/k-chat"), 0);
});

test("evaluateEligibility lists candidates in code-unit route-ID order", () => {
  const trio = evaluateEligibility(
    ["p/y-chat", "p/k-chat", "p/i-chat"].map(tieCandidate),
    REQUEST,
    evaluationOptions,
  );
  assert.deepEqual(
    trio.map((candidate) => candidate.routeId),
    ["p/i-chat", "p/k-chat", "p/y-chat"],
  );
  assert.ok(trio.every((candidate) => candidate.eligible));

  const mixed = evaluateEligibility(
    ["p/a-chat", "p/B-chat"].map(tieCandidate),
    REQUEST,
    evaluationOptions,
  );
  assert.deepEqual(
    mixed.map((candidate) => candidate.routeId),
    ["p/B-chat", "p/a-chat"],
  );
  assert.ok(mixed.every((candidate) => candidate.eligible));
});

test("selectRoute breaks equal-rate ties by code-unit route ID, any input order", () => {
  const trio = ["p/i-chat", "p/k-chat", "p/y-chat"].map(tieCandidate);
  const forward = selectRoute(trio, REQUEST, evaluationOptions);
  const reverse = selectRoute([...trio].reverse(), REQUEST, evaluationOptions);

  assert.equal(forward.status, "selected");
  assert.equal(forward.selected.routeId, "p/i-chat");
  assert.deepEqual(reverse, forward);

  const mixed = selectRoute(
    ["p/a-chat", "p/B-chat"].map(tieCandidate),
    REQUEST,
    evaluationOptions,
  );
  assert.equal(mixed.status, "selected");
  assert.equal(mixed.selected.routeId, "p/B-chat");
});

test("route selection never consults the process locale", () => {
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function localeCompare() {
    throw new Error(
      "locale-sensitive comparison must not run during route selection (TOG-5644)",
    );
  };
  try {
    const result = selectRoute(
      ["p/y-chat", "p/k-chat", "p/i-chat"].map(tieCandidate),
      REQUEST,
      evaluationOptions,
    );
    assert.equal(result.status, "selected");
    assert.equal(result.selected.routeId, "p/i-chat");
  } finally {
    String.prototype.localeCompare = original;
  }
});
