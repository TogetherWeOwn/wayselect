import test from "node:test";
import assert from "node:assert/strict";
import {
  EligibilityRequestError,
  evaluateEligibility,
} from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const defaultRequest = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

test("fails closed when no explicit provider allowlist is supplied", async () => {
  const { candidates } = await loadConfiguredCandidates();

  assert.throws(
    () =>
      evaluateEligibility(
        candidates,
        { ...defaultRequest, providerAllowlist: [] },
        evaluationOptions,
      ),
    EligibilityRequestError,
  );
});

test("explains missing capability data, disallowed providers, and unsupported operations", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(candidates, defaultRequest, evaluationOptions);
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));

  assert.equal(byRoute.get("northstar/alpha-chat").eligible, true);
  assert.deepEqual(byRoute.get("northstar/unknown-tools").reasons, [
    "missing-capability:toolUse",
  ]);
  assert.ok(byRoute.get("legacy/old-chat").reasons.includes("provider-not-allowed"));
  assert.ok(byRoute.get("northstar/image-lite").reasons.includes("operation-not-catalogued"));
  assert.ok(byRoute.get("northstar/image-lite").reasons.includes("operation-not-configured"));
  assert.ok(byRoute.get("orbit/retired-chat").reasons.includes("support-state:unsupported"));
});

test("marks old support evidence stale", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    {
      operation: "chat",
      requiredCapabilities: [],
      providerAllowlist: ["legacy"],
    },
    evaluationOptions,
  );
  const legacy = evaluations.find((candidate) => candidate.routeId === "legacy/old-chat");

  assert.equal(legacy.eligible, false);
  assert.ok(legacy.reasons.includes("stale-evidence"));
});

test("malformed evidence timestamps fail closed as invalid evidence", async () => {
  // TOG-4951 HIGH-1: Date.parse returns NaN for malformed input, and NaN
  // comparisons are always false, so without the invalid-evidence guard these
  // tampered timestamps passed with zero reasons (fail-open). Every variant
  // below must yield exactly ["invalid-evidence"] and eligible === false.
  const tamperedValues = [
    "not-a-date",
    "",
    "   ",
    "2026-13-45",
    "Infinity",
    "NaN",
    undefined,
    null,
    1727265600000,
    true,
    {},
    [],
  ];
  const { candidates } = await loadConfiguredCandidates();

  for (const observedAt of tamperedValues) {
    const tampered = structuredClone(candidates);
    const target = tampered.find(
      (candidate) => candidate.routeId === "northstar/alpha-chat",
    );
    target.evidence = { observedAt };

    const evaluations = evaluateEligibility(
      tampered,
      {
        operation: "chat",
        requiredCapabilities: [],
        providerAllowlist: ["northstar"],
      },
      evaluationOptions,
    );
    const alpha = evaluations.find(
      (candidate) => candidate.routeId === "northstar/alpha-chat",
    );

    assert.equal(alpha.eligible, false, `observedAt=${String(observedAt)}`);
    assert.deepEqual(
      [...alpha.reasons],
      ["invalid-evidence"],
      `observedAt=${String(observedAt)}`,
    );
  }
});

test("absent support evidence fails closed as missing evidence", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const tampered = structuredClone(candidates);
  const target = tampered.find(
    (candidate) => candidate.routeId === "northstar/alpha-chat",
  );
  delete target.evidence;

  const evaluations = evaluateEligibility(
    tampered,
    {
      operation: "chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
    },
    evaluationOptions,
  );
  const alpha = evaluations.find(
    (candidate) => candidate.routeId === "northstar/alpha-chat",
  );

  assert.equal(alpha.eligible, false);
  assert.deepEqual([...alpha.reasons], ["missing-evidence"]);
});

test("unknown required capabilities fail closed as missing data", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    { ...defaultRequest, requiredCapabilities: ["unpublishedCapability"] },
    evaluationOptions,
  );

  assert.ok(
    evaluations.every((candidate) =>
      candidate.reasons.includes("missing-capability:unpublishedCapability"),
    ),
  );
});

test("malformed candidates fail closed with EligibilityRequestError", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const valid = candidates.find((candidate) => candidate.routeId === "northstar/alpha-chat");

  assert.throws(
    () => evaluateEligibility(null, defaultRequest, evaluationOptions),
    EligibilityRequestError,
  );
  assert.throws(
    () => evaluateEligibility([{ ...valid, capabilities: null }], defaultRequest, evaluationOptions),
    /capabilities must be an object/,
  );
  assert.throws(
    () => evaluateEligibility([{ ...valid, catalogOperations: undefined }], defaultRequest, evaluationOptions),
    /catalogOperations must be an array/,
  );
  assert.throws(
    () =>
      evaluateEligibility(
        candidates,
        { ...defaultRequest, requiredCapabilities: null },
        evaluationOptions,
      ),
    EligibilityRequestError,
  );
});

test("malformed evidence observedAt fails closed as invalid-evidence", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const base = candidates.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  const malformed = [
    { observedAt: "garbage-not-a-date" },
    { observedAt: 12345 },
    { observedAt: "" },
    "not-an-object",
  ];

  for (const evidence of malformed) {
    const tampered = [{ ...base, evidence }];
    const evaluations = evaluateEligibility(
      tampered,
      defaultRequest,
      evaluationOptions,
    );
    assert.equal(evaluations[0].eligible, false);
    assert.ok(evaluations[0].reasons.includes("invalid-evidence"));
  }
});
