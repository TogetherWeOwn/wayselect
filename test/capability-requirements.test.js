// TOG-4794: typed capability requirements — richer fail-closed eligibility.
//
// Each typed requirement (input/output modalities, min context window, max
// output tokens, tool calling, structured output, reasoning flag) is covered
// present / absent / unknown, plus combined requirements, deterministic
// reason order, and an unchanged stable tie-break. Fixture-only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CatalogValidationError,
  EligibilityRequestError,
  computeCatalogSnapshotHash,
  evaluateEligibility,
  normalizeCatalog,
  normalizeSelectionRequest,
  selectRoute,
} from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const CHAT_REQUEST = Object.freeze({
  operation: "chat",
  requiredCapabilities: [],
  providerAllowlist: ["northstar", "orbit"],
});

function withRequirements(overrides) {
  return { ...CHAT_REQUEST, requirements: overrides };
}

async function candidatesWithLimits(limitsByRoute) {
  const { candidates } = await loadConfiguredCandidates();
  const cloned = structuredClone(candidates);
  for (const candidate of cloned) {
    const override = limitsByRoute[candidate.routeId];
    if (override !== undefined) {
      candidate.limits = { ...override };
    }
  }
  return cloned;
}

function minimalCandidate(overrides = {}) {
  return {
    routeId: "northstar/route",
    providerId: "northstar",
    modelId: "route",
    supportState: "configured",
    catalogOperations: ["chat"],
    configuredOperations: ["chat"],
    capabilities: {},
    evidence: { observedAt: new Date(evaluationOptions.now.getTime() - 60 * 60 * 1000).toISOString() },
    ...overrides,
  };
}

// ---- request normalization ----

test("requirements default to empty and freeze when absent", () => {
  const request = normalizeSelectionRequest({ ...CHAT_REQUEST });
  assert.deepEqual(request.requirements, {});
  assert.ok(Object.isFrozen(request));
});

test("requirements normalize with deterministic defaults", () => {
  const request = normalizeSelectionRequest(withRequirements({ toolCalling: true }));
  assert.deepEqual(request.requirements, {
    inputModalities: [],
    outputModalities: [],
    minContextWindow: null,
    maxOutputTokens: null,
    toolCalling: true,
    structuredOutput: false,
    reasoning: false,
  });
  assert.ok(Object.isFrozen(request.requirements));
});

test("unknown, malformed, or mis-shaped requirements are rejected at the boundary", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const bad = [
    { unknownRequirement: true },
    { inputModalities: "text" },
    { inputModalities: [""] },
    { outputModalities: [42] },
    { minContextWindow: "big" },
    { minContextWindow: -1 },
    { minContextWindow: 1.5 },
    { toolCalling: "yes" },
    { structuredOutput: 1 },
    { reasoning: 0 },
  ];
  for (const requirements of bad) {
    assert.throws(
      () => evaluateEligibility(candidates, withRequirements(requirements), evaluationOptions),
      EligibilityRequestError,
      JSON.stringify(requirements),
    );
  }
  assert.throws(
    () => evaluateEligibility(candidates, { ...CHAT_REQUEST, requirements: [] }, evaluationOptions),
    EligibilityRequestError,
  );
});

// ---- modalities ----

test("satisfied input/output modalities keep an eligible route eligible", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ inputModalities: ["text"], outputModalities: ["text"] }),
    evaluationOptions,
  );
  const alpha = evaluations.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  assert.equal(alpha.eligible, true);
  assert.deepEqual([...alpha.reasons], []);
});

test("unmet input modality fails closed with an explicit reason", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ inputModalities: ["image"] }),
    evaluationOptions,
  );
  const alpha = evaluations.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  assert.equal(alpha.eligible, false);
  assert.ok(alpha.reasons.includes("missing-modality:input:image"));
});

test("image-capable route satisfies an image input requirement on its own operation", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    {
      operation: "vision-chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
      requirements: { inputModalities: ["image"], outputModalities: ["text"] },
    },
    evaluationOptions,
  );
  const imageLite = evaluations.find(
    (candidate) => candidate.routeId === "northstar/image-lite",
  );
  assert.equal(imageLite.eligible, true);
  assert.deepEqual([...imageLite.reasons], []);
});

test("candidate without modalities data fails closed on any modality requirement", () => {
  const evaluations = evaluateEligibility(
    [minimalCandidate()],
    withRequirements({ inputModalities: ["text"] }),
    evaluationOptions,
  );
  assert.equal(evaluations[0].eligible, false);
  assert.deepEqual([...evaluations[0].reasons], ["missing-modality:input:text"]);
});

test("combined unmet modalities explain each missing value", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    {
      operation: "vision-chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
      requirements: { inputModalities: ["image", "text"], outputModalities: ["audio"] },
    },
    evaluationOptions,
  );
  const imageLite = evaluations.find(
    (candidate) => candidate.routeId === "northstar/image-lite",
  );
  assert.equal(imageLite.eligible, false);
  assert.deepEqual([...imageLite.reasons], [
    "missing-modality:input:text",
    "missing-modality:output:audio",
  ]);
});

// ---- context window ----

test("unknown context-window data fails closed on every candidate", async () => {
  // The pinned fixture carries no context_window fields, so limits are null:
  // any minContextWindow requirement must exclude, never guess.
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ minContextWindow: 8000 }),
    evaluationOptions,
  );
  assert.ok(evaluations.length > 0);
  assert.ok(
    evaluations.every((candidate) =>
      candidate.reasons.includes("missing-capability:contextWindow"),
    ),
  );
  assert.ok(evaluations.every((candidate) => candidate.eligible === false));
});

test("context window present, insufficient, and unknown each explain distinctly", async () => {
  const candidates = await candidatesWithLimits({
    "northstar/alpha-chat": { contextWindow: 128000, maxOutputTokens: null },
    "orbit/orbit-chat": { contextWindow: 4000, maxOutputTokens: null },
  });
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ minContextWindow: 8000 }),
    evaluationOptions,
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  assert.equal(byRoute.get("northstar/alpha-chat").eligible, true);
  assert.deepEqual([...byRoute.get("northstar/alpha-chat").reasons], []);
  assert.deepEqual([...byRoute.get("orbit/orbit-chat").reasons], [
    "insufficient-context-window",
  ]);
  assert.ok(
    byRoute.get("northstar/image-lite").reasons.includes("missing-capability:contextWindow"),
  );
});

// ---- max output tokens ----

test("unknown max-output-tokens data fails closed on every candidate", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ maxOutputTokens: 1000 }),
    evaluationOptions,
  );
  assert.ok(
    evaluations.every((candidate) =>
      candidate.reasons.includes("missing-capability:maxOutputTokens"),
    ),
  );
});

test("max output tokens present and insufficient explain distinctly", async () => {
  const candidates = await candidatesWithLimits({
    "northstar/alpha-chat": { contextWindow: null, maxOutputTokens: 4096 },
    "orbit/orbit-chat": { contextWindow: null, maxOutputTokens: 512 },
  });
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ maxOutputTokens: 2000 }),
    evaluationOptions,
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  assert.equal(byRoute.get("northstar/alpha-chat").eligible, true);
  assert.deepEqual([...byRoute.get("orbit/orbit-chat").reasons], [
    "insufficient-max-output-tokens",
  ]);
});

// ---- boolean flags (tool calling, structured output, reasoning) ----

test("toolCalling:true reuses the missing/unsupported capability vocabulary", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ toolCalling: true }),
    evaluationOptions,
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  // alpha-chat has tool_call=true: no tool reason.
  assert.ok(
    !byRoute.get("northstar/alpha-chat").reasons.some((reason) => reason.includes("toolUse")),
  );
  // unknown-tools has no tool_call data: missing, not unsupported.
  assert.deepEqual([...byRoute.get("northstar/unknown-tools").reasons], [
    "missing-capability:toolUse",
  ]);
  // image-lite has tool_call=false: unsupported, distinct from missing.
  assert.ok(
    byRoute.get("northstar/image-lite").reasons.includes("unsupported-capability:toolUse"),
  );
});

test("reasoning:true passes reasoning models and excludes the rest explicitly", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ reasoning: true }),
    evaluationOptions,
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  assert.ok(
    !byRoute.get("orbit/orbit-chat").reasons.some((reason) => reason.includes("reasoning")),
  );
  assert.ok(
    byRoute.get("northstar/alpha-chat").reasons.includes("unsupported-capability:reasoning"),
  );
  assert.ok(
    byRoute.get("northstar/unknown-tools").reasons.includes("missing-capability:reasoning"),
  );
});

test("structuredOutput:true excludes unstructured models explicitly", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ structuredOutput: true }),
    evaluationOptions,
  );
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  assert.ok(
    !byRoute
      .get("northstar/alpha-chat")
      .reasons.some((reason) => reason.includes("structuredOutput")),
  );
  assert.ok(
    byRoute
      .get("northstar/image-lite")
      .reasons.includes("unsupported-capability:structuredOutput"),
  );
});

test("false flags impose no constraint", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({ toolCalling: false, structuredOutput: false, reasoning: false }),
    evaluationOptions,
  );
  const alpha = evaluations.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  assert.equal(alpha.eligible, true);
  assert.deepEqual([...alpha.reasons], []);
});

// ---- combined requirements, order, tie-break ----

test("combined typed requirements evaluate together and stay deterministic", async () => {
  const candidates = await candidatesWithLimits({
    "northstar/alpha-chat": { contextWindow: 128000, maxOutputTokens: 4096 },
  });
  const first = evaluateEligibility(
    candidates,
    withRequirements({
      inputModalities: ["text"],
      outputModalities: ["text"],
      minContextWindow: 8000,
      maxOutputTokens: 2000,
      toolCalling: true,
      structuredOutput: true,
    }),
    evaluationOptions,
  );
  const second = evaluateEligibility(
    [...candidates].reverse(),
    withRequirements({
      inputModalities: ["text"],
      outputModalities: ["text"],
      minContextWindow: 8000,
      maxOutputTokens: 2000,
      toolCalling: true,
      structuredOutput: true,
    }),
    evaluationOptions,
  );
  const alpha = first.find((candidate) => candidate.routeId === "northstar/alpha-chat");
  assert.equal(alpha.eligible, true);
  assert.deepEqual([...alpha.reasons], []);
  assert.deepEqual(second, first);
});

test("multiple typed failures emit in fixed field order", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    withRequirements({
      inputModalities: ["image"],
      minContextWindow: 8000,
      maxOutputTokens: 1000,
      toolCalling: true,
    }),
    evaluationOptions,
  );
  const unknownTools = evaluations.find(
    (candidate) => candidate.routeId === "northstar/unknown-tools",
  );
  assert.deepEqual([...unknownTools.reasons], [
    "missing-modality:input:image",
    "missing-capability:contextWindow",
    "missing-capability:maxOutputTokens",
    "missing-capability:toolUse",
  ]);
});

test("explicit null thresholds normalize as absent (double-normalization round-trip)", () => {
  const request = normalizeSelectionRequest(
    withRequirements({ minContextWindow: null, maxOutputTokens: null }),
  );
  assert.equal(request.requirements.minContextWindow, null);
  assert.equal(request.requirements.maxOutputTokens, null);
});

test("overlapping legacy and typed capability checks never repeat a reason", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(
    candidates,
    {
      operation: "chat",
      requiredCapabilities: ["toolUse"],
      providerAllowlist: ["northstar"],
      requirements: { toolCalling: true },
    },
    evaluationOptions,
  );
  const imageLite = evaluations.find(
    (candidate) => candidate.routeId === "northstar/image-lite",
  );
  assert.deepEqual([...imageLite.reasons], [
    "operation-not-catalogued",
    "operation-not-configured",
    "unsupported-capability:toolUse",
  ]);
});

test("typed reason codes map to unknown/blocked display states", async () => {
  const { classifyEligibilityDisplay, ELIGIBILITY_STATE } = await import(
    "../web/eligibility.js"
  );
  assert.equal(
    classifyEligibilityDisplay({ eligible: false, reasons: ["missing-modality:input:image"] }),
    ELIGIBILITY_STATE.UNKNOWN,
  );
  assert.equal(
    classifyEligibilityDisplay({
      eligible: false,
      reasons: ["missing-capability:contextWindow"],
    }),
    ELIGIBILITY_STATE.UNKNOWN,
  );
  assert.equal(
    classifyEligibilityDisplay({
      eligible: false,
      reasons: ["insufficient-context-window"],
    }),
    ELIGIBILITY_STATE.BLOCKED,
  );
  assert.equal(
    classifyEligibilityDisplay({
      eligible: false,
      reasons: ["insufficient-max-output-tokens"],
    }),
    ELIGIBILITY_STATE.BLOCKED,
  );
});

test("stable tie-break is unchanged when typed requirements are present", async () => {
  const { candidates } = await loadConfiguredCandidates();
  // Legacy toolUse boolean stays on so alpha-chat (not the cheaper
  // unknown-tools stub) wins — the point is the ordering policy, unchanged.
  const request = {
    ...withRequirements({ inputModalities: ["text"], outputModalities: ["text"] }),
    requiredCapabilities: ["toolUse"],
  };
  const forward = selectRoute(candidates, request, evaluationOptions);
  const reverse = selectRoute([...candidates].reverse(), request, evaluationOptions);

  assert.equal(forward.status, "selected");
  assert.equal(forward.selected.routeId, "northstar/alpha-chat");
  assert.deepEqual(reverse, forward);
  assert.equal(
    forward.policy,
    "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
  );
});

test("legacy boolean-only requests are unaffected by the typed layer", async () => {
  const { candidates } = await loadConfiguredCandidates();
  const evaluations = evaluateEligibility(candidates, CHAT_REQUEST, evaluationOptions);
  const byRoute = new Map(evaluations.map((candidate) => [candidate.routeId, candidate]));
  // alpha-chat carries no typed reasons at all when no requirements are set.
  assert.ok(
    [...byRoute.get("northstar/alpha-chat").reasons].every(
      (reason) =>
        !reason.startsWith("missing-modality:") &&
        !reason.includes("contextWindow") &&
        !reason.includes("max-output-tokens") &&
        !reason.includes("insufficient-"),
    ),
  );
});

// ---- catalog normalization carries the typed data ----

function inlineCatalogProbe(models) {
  const catalog = {
    northstar: {
      id: "northstar",
      name: "Northstar Synthetic Provider",
      models,
    },
  };
  const provenance = {
    source: "synthetic://wayselect/test",
    snapshotTimestamp: "2026-09-26T14:00:00.000Z",
    snapshotHash: computeCatalogSnapshotHash(catalog),
  };
  return normalizeCatalog(catalog, provenance);
}

test("catalog normalization exposes modalities and token limits", () => {
  const result = inlineCatalogProbe({
    "alpha-chat": {
      id: "alpha-chat",
      name: "Alpha Chat",
      reasoning: false,
      tool_call: true,
      structured_output: true,
      modalities: { input: ["text"], output: ["text"] },
      context_window: 128000,
      max_output_tokens: 4096,
      cost: { input: 1, output: 2 },
    },
  });
  const [entry] = result.entries;
  assert.deepEqual(entry.modalities, { input: ["text"], output: ["text"] });
  assert.deepEqual(entry.limits, { contextWindow: 128000, maxOutputTokens: 4096 });
  assert.ok(Object.isFrozen(entry.modalities));
  assert.ok(Object.isFrozen(entry.limits));
});

test("catalog normalization defaults absent limits to unknown, never zero", () => {
  const result = inlineCatalogProbe({
    "alpha-chat": {
      id: "alpha-chat",
      name: "Alpha Chat",
      modalities: { input: ["text"], output: ["text"] },
    },
  });
  assert.deepEqual(result.entries[0].limits, { contextWindow: null, maxOutputTokens: null });
});

test("malformed token limits are rejected at the catalog boundary", () => {
  for (const [field, value] of [
    ["context_window", -1],
    ["context_window", 1.5],
    ["context_window", "big"],
    ["max_output_tokens", -100],
    ["max_output_tokens", true],
  ]) {
    assert.throws(
      () =>
        inlineCatalogProbe({
          "alpha-chat": {
            id: "alpha-chat",
            name: "Alpha Chat",
            modalities: { input: ["text"], output: ["text"] },
            [field]: value,
          },
        }),
      CatalogValidationError,
      `${field}=${String(value)}`,
    );
  }
});
