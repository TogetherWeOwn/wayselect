// OpenAI-compatible chat-completions surface skeleton — Phase 1 (TOG-5951,
// gateway spec TOG-5939 §1.1/§1.3/§1.6).
//
// FakeTransport-backed only (`networkUsed:false` is enforced on every result,
// so this module cannot spend or touch the network). No credentials live here:
// the caller supplies the expected gateway key at call time (operator-held,
// secret-bound upstream of this module), and the key never appears in logs,
// errors, or responses.
//
// What this slice implements:
//   `model` semantics (§1.3): "auto" routes, an exact route-id match pins
//     (subject to eligibility — ineligible pins 400, never substituted),
//     any other string falls back to auto with the raw string echoed in
//     `wayselect.requestedModel`.
//   Request subset (§1.1, non-streaming only): system/user/assistant text
//     messages; `tools` (non-streaming) and `response_format: json_*` feed
//     typed eligibility requirements (§2.3); `max_tokens` /
//     `max_completion_tokens` feeds `requirements.maxOutputTokens` —
//     candidates without declared limit data fail closed on that dimension,
//     per the existing eligibility boundary.
//   Intake caps (TOG-7307, src/intakeLimits.js): at most 32 messages, 16k
//     chars per normalized message text, 64k chars combined — fail closed
//     with 400 (`too_many_messages` / `message_too_large` /
//     `messages_too_large`).
//   Error table (§1.6, OpenAI envelope only): 400 `invalid_request_error`,
//     401 `authentication_error` (with `WWW-Authenticate: Bearer`; missing
//     and wrong keys are byte-identical), 500 `api_error` with no detail
//     leaked.
//   Response: standard `ChatCompletion` shape plus the documented `wayselect`
//     extension (`tier`/`classifierConfidence` are null until a later phase
//     adds classification; `dryRun:true`, `synthetic:true` always).
//
// Explicitly NOT in this slice: streaming/SSE (Phase 2), the Anthropic
// surface (Phase 2), live transport (Phase 3, CISO-gated), HTTP binding —
// the handler is a pure in-process function so conformance stays offline.
// `stream:true` fails closed with 400 until Phase 2 lands.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { EligibilityRequestError, evaluateEligibility } from "./eligibility.js";
import {
  MAX_GATEWAY_MESSAGE_CHARS,
  MAX_GATEWAY_MESSAGES,
  MAX_GATEWAY_TOTAL_CHARS,
} from "./intakeLimits.js";
import { selectRoute } from "./selection.js";
import { FakeTransport } from "./transport.js";

const VALID_ROLES = new Set(["system", "user", "assistant"]);

// Top-level request keys this slice understands (§1.1). Every other key
// fails closed with 400 `unknown_field` so client typos (e.g. `mesages`)
// surface instead of passing silently — the same fail-closed boundary style
// as `assertKnownKeys` in catalog.js / sellerSubmission.js. "penalties" in
// the §1.1 note maps to the two real OpenAI penalty params below.
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "n",
  "logprobs",
  "functions",
  "tools",
  "tool_choice",
  "response_format",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "stop",
  "user",
  "seed",
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
]);

// Content-part types that carry non-text modalities. Any part of these types
// is rejected with `unsupported_modality` (§1.6); text parts pass.
const NON_TEXT_PART_TYPES = new Set(["image_url", "image", "input_audio"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(httpStatus, type, code, message) {
  return {
    httpStatus,
    body: Object.freeze({
      error: Object.freeze({ message, type, code }),
    }),
  };
}

function gatewayMisconfigured() {
  // 500 with no detail: operator configuration problems (including
  // credentials) must never leak internals (§1.6).
  return errorResponse(500, "api_error", "internal_error", "Gateway misconfigured.");
}

function unauthorized() {
  // 401 with the RFC 9110 auth challenge. Missing and wrong keys return
  // byte-identical status, body, and headers so callers cannot distinguish
  // them (no credential oracle, §1.6). A future HTTP binding forwards
  // `headers` verbatim alongside `httpStatus`/`body`.
  return {
    ...errorResponse(
      401,
      "authentication_error",
      "invalid_api_key",
      "Invalid or missing gateway credentials.",
    ),
    headers: Object.freeze({ "WWW-Authenticate": "Bearer" }),
  };
}

function bearerKey(headers) {
  const raw =
    headers?.authorization ?? headers?.Authorization ?? headers?.["authorization"];
  if (typeof raw !== "string") {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(raw.trim());
  return match ? match[1] : null;
}

function keysEqual(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") {
    return false;
  }
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function countWords(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  return words.length;
}

// Normalize one message's content to plain text, or return an error
// descriptor. Only system/user/assistant roles with text content pass;
// image/audio parts fail closed with `unsupported_modality`.
function extractMessageText(message, index) {
  const label = `messages[${index}]`;
  if (!isPlainObject(message)) {
    return { ok: false, code: "invalid_messages", message: `${label} must be an object.` };
  }
  if (!VALID_ROLES.has(message.role)) {
    return {
      ok: false,
      code: "unsupported_role",
      message: `${label}.role must be one of system, user, assistant.`,
    };
  }
  const content = message.content;
  if (typeof content === "string") {
    return { ok: true, role: message.role, text: content };
  }
  if (Array.isArray(content) && content.length > 0) {
    const texts = [];
    for (const [partIndex, part] of content.entries()) {
      if (!isPlainObject(part) || typeof part.type !== "string") {
        return {
          ok: false,
          code: "invalid_content_part",
          message: `${label}.content[${partIndex}] must be an object with a string type.`,
        };
      }
      if (NON_TEXT_PART_TYPES.has(part.type)) {
        return {
          ok: false,
          code: "unsupported_modality",
          message: `${label}.content[${partIndex}] carries an unsupported modality (text only in v1).`,
        };
      }
      if (part.type !== "text" || typeof part.text !== "string") {
        return {
          ok: false,
          code: "invalid_content_part",
          message: `${label}.content[${partIndex}] must be a text part with string text.`,
        };
      }
      texts.push(part.text);
    }
    return { ok: true, role: message.role, text: texts.join("") };
  }
  return {
    ok: false,
    code: "invalid_messages",
    message: `${label}.content must be a string or a non-empty array of content parts.`,
  };
}

function invalidMaxTokens(value) {
  return !Number.isInteger(value) || value < 0;
}

export async function handleChatCompletionsRequest(input) {
  const { headers, body, gatewayKey, candidates, eligibilityOptions, transport } =
    input ?? {};

  // Programmer contract (mirrors the fail-fast boundary style of
  // eligibility.js): malformed wiring throws; request-level problems return
  // HTTP-shaped errors below.
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array");
  }
  if (!isPlainObject(eligibilityOptions)) {
    throw new TypeError("eligibilityOptions must be an object");
  }
  const activeTransport = transport ?? new FakeTransport();
  if (typeof activeTransport?.send !== "function") {
    throw new TypeError("transport.send must be a function");
  }

  // Operator misconfiguration (including a missing expected key) fails
  // closed with no detail — never an auth bypass, never a leak (§1.6).
  if (typeof gatewayKey !== "string" || gatewayKey === "") {
    return gatewayMisconfigured();
  }
  if (!keysEqual(bearerKey(headers), gatewayKey)) {
    return unauthorized();
  }

  if (!isPlainObject(body)) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_request",
      "Request body must be a JSON object.",
    );
  }

  // ---- unknown top-level keys fail closed (R4-13): typos like `mesages`
  // must surface, never pass silently. Runs before any field-specific
  // validation so the reported key is always the unknown one.
  const unknownKey = Object.keys(body).find((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
  if (unknownKey !== undefined) {
    return errorResponse(
      400,
      "invalid_request_error",
      "unknown_field",
      `Request contains unknown field: ${unknownKey}.`,
    );
  }

  // ---- model (required; semantics per §1.3) ----
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return errorResponse(
      400,
      "invalid_request_error",
      "missing_model",
      "Request model must be a non-empty string.",
    );
  }
  const requestedModel = body.model;

  // ---- messages (required, text-only v1) ----
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_messages",
      "Request messages must be a non-empty array.",
    );
  }
  // TOG-7307: intake count cap (src/intakeLimits.js). Structural — enforced
  // before per-message normalization so oversized batches fail fast.
  if (body.messages.length > MAX_GATEWAY_MESSAGES) {
    return errorResponse(
      400,
      "invalid_request_error",
      "too_many_messages",
      `Request messages must contain at most ${MAX_GATEWAY_MESSAGES} messages.`,
    );
  }
  const normalizedMessages = [];
  for (const [index, message] of body.messages.entries()) {
    const parsed = extractMessageText(message, index);
    if (!parsed.ok) {
      const httpStatus = 400;
      return errorResponse(httpStatus, "invalid_request_error", parsed.code, parsed.message);
    }
    // TOG-7307: per-message text cap (src/intakeLimits.js), measured after
    // content-part normalization so joined text parts count as one message.
    if (parsed.text.length > MAX_GATEWAY_MESSAGE_CHARS) {
      return errorResponse(
        400,
        "invalid_request_error",
        "message_too_large",
        `messages[${index}] must be at most ${MAX_GATEWAY_MESSAGE_CHARS} characters.`,
      );
    }
    normalizedMessages.push({ role: parsed.role, text: parsed.text });
  }
  // TOG-7307: combined text cap (src/intakeLimits.js) over normalized text,
  // so one request cannot balloon prompt assembly or the transport payload.
  let totalChars = 0;
  for (const message of normalizedMessages) {
    totalChars += message.text.length;
  }
  if (totalChars > MAX_GATEWAY_TOTAL_CHARS) {
    return errorResponse(
      400,
      "invalid_request_error",
      "messages_too_large",
      `Request messages must total at most ${MAX_GATEWAY_TOTAL_CHARS} characters.`,
    );
  }

  // ---- streaming: Phase 1 is non-streaming only (fail closed) ----
  if (body.stream !== undefined && body.stream !== false) {
    if (body.stream === true) {
      return errorResponse(
        400,
        "invalid_request_error",
        "streaming_not_supported",
        "Streaming is not supported in this slice (non-streaming only).",
      );
    }
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_stream",
      "Request stream must be a boolean when present.",
    );
  }

  // ---- parameters that mislead under a fake transport: reject ----
  if (body.n !== undefined && body.n !== 1) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_n",
      "Only n: 1 is supported in this slice.",
    );
  }
  if (body.logprobs) {
    return errorResponse(
      400,
      "invalid_request_error",
      "unsupported_parameter",
      "logprobs is not supported in this slice.",
    );
  }
  if (body.functions !== undefined) {
    return errorResponse(
      400,
      "invalid_request_error",
      "unsupported_parameter",
      "Legacy functions are not supported; use tools instead.",
    );
  }

  // ---- tools (non-streaming only): feeds requirements.toolCalling (§2.3) ----
  let toolCalling = false;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_tools",
        "Request tools must be an array when present.",
      );
    }
    toolCalling = body.tools.length > 0;
  }
  if (body.tool_choice !== undefined && !toolCalling) {
    return errorResponse(
      400,
      "invalid_request_error",
      "invalid_tools",
      "Request tool_choice requires tools.",
    );
  }

  // ---- response_format: json_* feeds requirements.structuredOutput (§2.3) ----
  let structuredOutput = false;
  if (body.response_format !== undefined) {
    const format = body.response_format;
    const formatType = typeof format === "string" ? format : format?.type;
    if (formatType === "json_object" || formatType === "json_schema") {
      structuredOutput = true;
    } else if (formatType === "text") {
      structuredOutput = false;
    } else {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_response_format",
        "Request response_format must be text, json_object, or json_schema in this slice.",
      );
    }
  }

  // ---- max_tokens / max_completion_tokens: feeds maxOutputTokens (§2.3) ----
  let maxOutputTokens = null;
  const tokenLimit = body.max_completion_tokens ?? body.max_tokens;
  if (tokenLimit !== undefined) {
    if (invalidMaxTokens(tokenLimit)) {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_max_tokens",
        "Request max_tokens must be a non-negative integer when present.",
      );
    }
    maxOutputTokens = tokenLimit;
  }
  // temperature, top_p, stop, user, seed, frequency_penalty,
  // presence_penalty, logit_bias and the other KNOWN_TOP_LEVEL_KEYS
  // pass-through/ignored fields (§1.1) are accepted without validation.

  const requirements = {};
  if (toolCalling) {
    requirements.toolCalling = true;
  }
  if (structuredOutput) {
    requirements.structuredOutput = true;
  }
  if (maxOutputTokens !== null) {
    requirements.maxOutputTokens = maxOutputTokens;
  }
  if (candidates.length === 0) {
    return errorResponse(
      400,
      "invalid_request_error",
      "no_eligible_route",
      "No eligible route for this request.",
    );
  }

  // ---- routing (§1.3): pinned exact match or auto ----
  let evaluations;
  let selectionRequest;
  try {
    selectionRequest = Object.freeze({
      operation: "chat",
      // The operator's configured candidate set is the provider allowlist:
      // derived explicitly from configuration, never an allow-all wildcard.
      providerAllowlist: Object.freeze(
        [...new Set(candidates.map((candidate) => candidate?.providerId))]
          .filter((provider) => typeof provider === "string" && provider !== "")
          .sort(),
      ),
      requirements: Object.freeze({ ...requirements }),
    });
    evaluations = evaluateEligibility(candidates, selectionRequest, eligibilityOptions);
  } catch (error) {
    // Operator/fixture data problems (malformed candidates or options) are
    // gateway misconfiguration: 500 with no detail, never a client 400.
    if (error instanceof EligibilityRequestError) {
      return gatewayMisconfigured();
    }
    throw error;
  }

  const eligible = evaluations.filter((evaluation) => evaluation.eligible);
  const pinned = evaluations.find((evaluation) => evaluation.routeId === requestedModel);

  let selectedRouteId;
  if (pinned) {
    // Exact match pins: ineligible pins 400, never silent substitution.
    if (!pinned.eligible) {
      return errorResponse(
        400,
        "invalid_request_error",
        "model_not_eligible",
        `Model '${requestedModel}' is not eligible for this request (${pinned.reasons.join(", ")}).`,
      );
    }
    selectedRouteId = pinned.routeId;
  } else if (requestedModel === "auto" || !evaluations.some((e) => e.routeId === requestedModel)) {
    // "auto", plus any other string (keeps hardcoded clients working —
    // the requested string is echoed in wayselect.requestedModel).
    let selection;
    try {
      selection = selectRoute(candidates, selectionRequest, eligibilityOptions);
    } catch (error) {
      if (error instanceof EligibilityRequestError) {
        return gatewayMisconfigured();
      }
      throw error;
    }
    if (selection.status !== "selected" || !selection.selected) {
      return errorResponse(
        400,
        "invalid_request_error",
        "no_eligible_route",
        "No eligible route for this request.",
      );
    }
    selectedRouteId = selection.selected.routeId;
  }

  // ---- fake-backed execution: network use is forbidden in this slice ----
  const combinedPrompt = normalizedMessages
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  let transportResult;
  try {
    transportResult = await activeTransport.send({
      route: { routeId: selectedRouteId },
      payload: { prompt: combinedPrompt, messageCount: normalizedMessages.length },
    });
  } catch {
    return gatewayMisconfigured();
  }
  if (
    !transportResult ||
    transportResult.networkUsed !== false ||
    typeof transportResult.output?.text !== "string"
  ) {
    // Phase-1 invariant: only FakeTransport-shaped, offline results may
    // back this surface. Anything else is a misconfiguration, never spend.
    return gatewayMisconfigured();
  }

  const completionText = transportResult.output.text;
  const promptTokens = countWords(combinedPrompt);
  const completionTokens = countWords(completionText);

  return {
    httpStatus: 200,
    body: Object.freeze({
      id: `chatcmpl-syn-${randomBytes(12).toString("hex")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: selectedRouteId,
      choices: Object.freeze([
        Object.freeze({
          index: 0,
          message: Object.freeze({ role: "assistant", content: completionText }),
          finish_reason: "stop",
        }),
      ]),
      // Synthetic estimates (whitespace counts), never tokenizer output.
      usage: Object.freeze({
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      }),
      wayselect: Object.freeze({
        selectedRouteId,
        requestedModel,
        // Classification lands in a later phase; null means "not classified",
        // never a silent default tier.
        tier: null,
        classifierConfidence: null,
        eligibleCount: eligible.length,
        dryRun: true,
        synthetic: true,
      }),
    }),
  };
}
