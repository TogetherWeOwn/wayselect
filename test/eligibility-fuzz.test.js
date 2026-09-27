// TOG-5733: property/fuzz tests over the eligibility requirement matrix.
//
// Deterministic seeded fuzzer (mulberry32, fixed seed): randomized
// requirements x randomized candidate catalogs assert the evaluator contract:
// no panics on well-formed input, no duplicate reasons, deterministic
// (input-order-independent) output, eligible <=> zero reasons, and every
// reason comes from the known vocabulary. Malformed inputs must fail closed
// with EligibilityRequestError, never an uncontrolled TypeError.
//
// Fixture-only, no network. If this fuzzer ever throws an uncontrolled error,
// that crash is a bug: file it as its own card, do not relax the test.

import test from "node:test";
import assert from "node:assert/strict";
import { EligibilityRequestError, evaluateEligibility } from "../src/index.js";
import { evaluationNow, evaluationOptions } from "../support/helpers.js";

// Fixed seed: the same suite must generate the same cases on every run.
const SEED = 0x5733;
const ITERATIONS = 300;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const MODALITY_POOL = ["text", "image", "audio", "video", "hologram"];
const CAPABILITY_POOL = [
  "toolUse",
  "structuredOutput",
  "reasoning",
  "attachment",
  "imageInput",
  "textInput",
  "textOutput",
];
const OPERATION_POOL = ["chat", "vision-chat", "embed", "transcribe"];
const PROVIDER_POOL = ["northstar", "orbit", "legacy", "acme"];
const SUPPORT_STATES = [
  "configured",
  "conformance-tested",
  "catalogued",
  "unsupported",
  "retired",
];
const CAPABILITY_VALUES = [true, false, null, 0, 1, "yes", {}, []];
// Malformed-but-tolerated limit shapes: tokenCountOrNull maps these to unknown.
const LIMIT_VALUES = [null, 0, 1, 512, 4096, 128000, 2 ** 31, -1, 1.5, "big", true];
const MALFORMED_EVIDENCE = ["not-a-date", "", 1727265600000, true, {}, [], null];

// Every reason the evaluator may emit (src/eligibility.js + web/eligibility.js
// display contract). `support-state:` and `missing-capability:` embed free-form
// names, so those segments are open-ended; everything else is a fixed token.
const REASON_VOCABULARY =
  /^(support-state:.+|provider-not-allowed|operation-not-catalogued|operation-not-configured|(missing|unsupported)-capability:.+|missing-modality:(input|output):.+|insufficient-context-window|insufficient-max-output-tokens|missing-evidence|invalid-evidence|future-evidence|stale-evidence|stale-catalog|future-catalog)$/;

function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

function randomSubset(rng, pool, { allowEmpty = true } = {}) {
  const out = pool.filter(() => rng() < 0.4);
  if (!allowEmpty && out.length === 0) {
    out.push(pick(rng, pool));
  }
  return out;
}

function maybeDuplicate(rng, values) {
  // Feed duplicates through normalization: the evaluator must dedupe reasons.
  if (values.length > 0 && rng() < 0.2) {
    return [...values, pick(rng, values)];
  }
  return values;
}

function randomCapabilities(rng) {
  const capabilities = {};
  for (const name of randomSubset(rng, CAPABILITY_POOL)) {
    if (rng() < 0.1) {
      continue; // absent key: unknown data fails closed as missing-capability
    }
    capabilities[name] = pick(rng, CAPABILITY_VALUES);
  }
  if (rng() < 0.1) {
    capabilities[`custom-cap-${Math.floor(rng() * 4)}`] = pick(rng, CAPABILITY_VALUES);
  }
  return capabilities;
}

function randomEvidence(rng) {
  const nowMs = evaluationNow().getTime();
  const roll = rng();
  if (roll < 0.55) {
    // Fresh: observed between now and 71h ago (maxEvidenceAgeMs is 72h).
    return { observedAt: new Date(nowMs - Math.floor(rng() * 71 * 3600 * 1000)).toISOString() };
  }
  if (roll < 0.65) {
    // Stale: older than 72h.
    return {
      observedAt: new Date(nowMs - (73 + Math.floor(rng() * 720)) * 3600 * 1000).toISOString(),
    };
  }
  if (roll < 0.72) {
    // Future evidence.
    return { observedAt: new Date(nowMs + (1 + Math.floor(rng() * 48)) * 3600 * 1000).toISOString() };
  }
  if (roll < 0.85) {
    return { observedAt: pick(rng, MALFORMED_EVIDENCE) };
  }
  return undefined; // absent: missing-evidence
}

function randomCandidate(rng, index) {
  const provider = pick(rng, PROVIDER_POOL);
  const candidate = {
    routeId: `${provider}/fuzz-${index}`,
    providerId: provider,
    modelId: `fuzz-${index}`,
    supportState: pick(rng, SUPPORT_STATES),
    catalogOperations: randomSubset(rng, OPERATION_POOL),
    configuredOperations: randomSubset(rng, OPERATION_POOL),
    capabilities: randomCapabilities(rng),
  };
  const evidence = randomEvidence(rng);
  if (evidence !== undefined) {
    candidate.evidence = evidence;
  }
  if (rng() < 0.7) {
    candidate.modalities = {
      input: maybeDuplicate(rng, randomSubset(rng, MODALITY_POOL)),
      output: maybeDuplicate(rng, randomSubset(rng, MODALITY_POOL)),
    };
  } else if (rng() < 0.15) {
    // Malformed-but-tolerated shapes: stringArrayOrNull maps these to unknown,
    // which must fail closed with a missing-modality reason, never a panic.
    candidate.modalities = { input: "text", output: ["text", 42] };
  }
  if (rng() < 0.7) {
    candidate.limits = {
      contextWindow: pick(rng, LIMIT_VALUES),
      maxOutputTokens: pick(rng, LIMIT_VALUES),
    };
  }
  return candidate;
}

function randomRequirements(rng) {
  if (rng() < 0.3) {
    return undefined; // legacy boolean-only request: typed layer must stay out
  }
  const requirements = {};
  if (rng() < 0.6) {
    requirements.inputModalities = maybeDuplicate(rng, randomSubset(rng, MODALITY_POOL));
  }
  if (rng() < 0.6) {
    requirements.outputModalities = maybeDuplicate(rng, randomSubset(rng, MODALITY_POOL));
  }
  if (rng() < 0.5) {
    requirements.minContextWindow = pick(rng, [null, 0, 1, 512, 8000, 128000, 2 ** 31]);
  }
  if (rng() < 0.5) {
    requirements.maxOutputTokens = pick(rng, [null, 0, 1, 512, 2000, 4096, 2 ** 31]);
  }
  for (const flag of ["toolCalling", "structuredOutput", "reasoning"]) {
    const roll = rng();
    if (roll < 0.35) {
      requirements[flag] = true;
    } else if (roll < 0.5) {
      requirements[flag] = false;
    }
  }
  return requirements;
}

function randomCase(rng, caseIndex) {
  const count = 1 + Math.floor(rng() * 6);
  const candidates = Array.from({ length: count }, (_, i) => randomCandidate(rng, caseIndex * 10 + i));
  const request = {
    operation: pick(rng, OPERATION_POOL),
    requiredCapabilities: maybeDuplicate(
      rng,
      randomSubset(rng, [...CAPABILITY_POOL, "unpublishedCapability", " "]),
    ),
    providerAllowlist: randomSubset(rng, PROVIDER_POOL, { allowEmpty: false }),
  };
  const requirements = randomRequirements(rng);
  if (requirements !== undefined) {
    request.requirements = requirements;
  }
  return { candidates, request };
}

function checkEvaluatorContract(first, second, label) {
  // Input-order independence: reversed candidate order yields identical output.
  assert.deepEqual(second, first, `${label}: output depends on input order`);
  const routeIds = first.map((evaluation) => evaluation.routeId);
  assert.deepEqual(
    routeIds,
    [...routeIds].sort((left, right) => left.localeCompare(right)),
    `${label}: output not sorted by routeId`,
  );
  for (const evaluation of first) {
    assert.ok(Object.isFrozen(evaluation), `${label}: evaluation not frozen`);
    assert.ok(Object.isFrozen(evaluation.reasons), `${label}: reasons not frozen`);
    assert.equal(
      new Set(evaluation.reasons).size,
      evaluation.reasons.length,
      `${label}: duplicate reasons on ${evaluation.routeId}: ${evaluation.reasons.join(", ")}`,
    );
    assert.equal(
      evaluation.eligible,
      evaluation.reasons.length === 0,
      `${label}: eligible/reasons mismatch on ${evaluation.routeId}`,
    );
    for (const reason of evaluation.reasons) {
      assert.equal(typeof reason, "string", `${label}: non-string reason`);
      assert.match(reason, REASON_VOCABULARY, `${label}: reason outside vocabulary: ${reason}`);
    }
  }
}

test("fuzzer is deterministic for the fixed seed", () => {
  const first = randomCase(mulberry32(SEED), 0);
  const second = randomCase(mulberry32(SEED), 0);
  assert.deepEqual(second, first);
  const third = randomCase(mulberry32(SEED + 1), 0);
  assert.notDeepEqual(third, first, "different seeds must diverge");
});

test(`property: ${ITERATIONS} randomized requirement/catalog cases hold the contract`, () => {
  const rng = mulberry32(SEED);
  let typedCases = 0;
  for (let caseIndex = 0; caseIndex < ITERATIONS; caseIndex += 1) {
    const { candidates, request } = randomCase(rng, caseIndex);
    if (request.requirements !== undefined) {
      typedCases += 1;
    }
    // Well-formed shapes must never panic: any throw here is a fuzzer-found
    // crash and must become its own bug card, not a relaxed assertion.
    const first = evaluateEligibility(candidates, request, evaluationOptions);
    const second = evaluateEligibility([...candidates].reverse(), request, evaluationOptions);
    checkEvaluatorContract(first, second, `case ${caseIndex}`);
  }
  assert.ok(typedCases > ITERATIONS / 2, `too few typed-requirement cases: ${typedCases}`);
});

test("property: malformed fuzz shapes fail closed with EligibilityRequestError", () => {
  const rng = mulberry32(SEED);
  const { candidates, request } = randomCase(rng, 0);
  const valid = candidates[0];

  const badCandidates = [
    null,
    { ...valid, routeId: "" },
    { ...valid, supportState: "" },
    { ...valid, capabilities: null },
    { ...valid, capabilities: [] },
    { ...valid, catalogOperations: ["chat", ""] },
    { ...valid, catalogOperations: undefined },
    { ...valid, rates: "free" },
  ];
  for (const bad of badCandidates) {
    assert.throws(
      () => evaluateEligibility([bad], request, evaluationOptions),
      (error) => error instanceof EligibilityRequestError,
      `expected EligibilityRequestError, not a panic: ${JSON.stringify(bad)}`,
    );
  }

  const badRequests = [
    { ...request, requirements: { unknownRequirement: true } },
    { ...request, requirements: { inputModalities: "text" } },
    { ...request, requirements: { inputModalities: [""] } },
    { ...request, requirements: { minContextWindow: -1 } },
    { ...request, requirements: { minContextWindow: 1.5 } },
    { ...request, requirements: { maxOutputTokens: "big" } },
    { ...request, requirements: { toolCalling: "yes" } },
    { ...request, providerAllowlist: [] },
    { ...request, operation: "" },
  ];
  for (const bad of badRequests) {
    assert.throws(
      () => evaluateEligibility(candidates, bad, evaluationOptions),
      (error) => error instanceof EligibilityRequestError,
      `expected EligibilityRequestError, not a panic: ${JSON.stringify(bad)}`,
    );
  }
});
