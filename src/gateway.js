// Gateway surfaces — Phase 1 OpenAI skeleton (TOG-5951) plus Phase 2
// Anthropic surface + streaming SSE (TOG-5956, gateway spec TOG-5939
// §1.2/§1.3/§1.5/§1.6).
//
// FakeTransport-backed only (`networkUsed:false` is enforced on every result,
// so this module cannot spend or touch the network). No credentials live here:
// the caller supplies the expected gateway key at call time (operator-held,
// secret-bound upstream of this module), and the key never appears in logs,
// errors, or responses.
//
// What this slice implements:
//   OpenAI surface `POST /v1/chat/completions` (§1.1): `model` semantics
//     (§1.3): "auto" routes, an exact route-id match pins (subject to
//     eligibility — ineligible pins 400, never substituted), any other
//     string falls back to auto with the raw string echoed in
//     `wayselect.requestedModel`.
//   Anthropic surface `POST /v1/messages` (§1.2): the same `model`
//     semantics (§1.3); `max_tokens` required (per Anthropic) and fed to
//     `requirements.maxOutputTokens`, so candidates without declared limit
//     data fail closed on that dimension per the existing eligibility
//     boundary; user/assistant text blocks only plus an optional `system`
//     prompt; `temperature`/`top_p`/`stop_sequences` accepted-and-ignored.
//   Request subsets (non-streaming): system/user/assistant text messages;
//     `tools` (non-streaming) and OpenAI `response_format: json_*` feed
//     typed eligibility requirements (§2.3); `max_tokens` /
//     `max_completion_tokens` feeds `requirements.maxOutputTokens` on the
//     OpenAI surface when present.
//   Streaming/SSE on BOTH surfaces (§1.5) from one normalized delta stream:
//     the full fake text is resolved (with retry) before the first byte is
//     rendered, so upstream retry can only ever happen before the first
//     byte — once streaming starts there is no second response, only stream
//     termination. OpenAI: `data: {chunk}` lines with `choices[].delta` plus
//     a terminal chunk and `data: [DONE]`. Anthropic: the `message_start` /
//     `content_block_start` / `content_block_delta` / `content_block_stop` /
//     `message_delta` / `message_stop` event sequence.
//   `tools` (non-empty) + `stream:true` → 400 on both surfaces (tool-call
//     delta mapping deferred, spec §5).
//   Intake caps (TOG-7307, src/intakeLimits.js): at most 32 messages, 16k
//     chars per normalized message text, 64k chars combined — fail closed
//     with 400 (`too_many_messages` / `message_too_large` /
//     `messages_too_large`).
//   Error tables (§1.6): 400 `invalid_request_error`, 401
//     `authentication_error` (with `WWW-Authenticate: Bearer`; missing and
//     wrong keys are byte-identical), 500 `api_error` with no detail leaked.
//     Each surface keeps its vendor envelope (`{error:{message,type,code}}`
//     vs `{type:"error",error:{type,message}}` — the Anthropic envelope
//     carries no `code` per the vendor shape).
//   Responses: standard `ChatCompletion` / Anthropic `message` shapes plus
//     the documented `wayselect` extension (`tier`/`classifierConfidence`
//     are null until a later phase adds classification; `dryRun:true`,
//     `synthetic:true` always, including on streams).
//
// Explicitly NOT in this slice: live transport (Phase 3, CISO-gated), HTTP
// binding — the handlers are pure in-process functions (streaming returns
// the exact SSE bytes as a string) so conformance stays offline.

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
const ANTHROPIC_ROLES = new Set(["user", "assistant"]);

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

// Upstream retry budget. Retries happen only while resolving the full fake
// text — i.e. strictly before the first SSE byte is rendered — so a killed
// upstream can never produce a partial stream followed by a second response.
const MAX_SEND_ATTEMPTS = 3;

// Streaming slices the completion text into fixed-size character deltas so
// byte-shape tests pin exact output deterministically.
const STREAM_SLICE_CHARS = 16;

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

// Anthropic vendor envelope (§1.6): `{type:"error",error:{type,message}}` —
// no `code` field, per the vendor shape. Codes stay OpenAI-surface-only.
function anthropicError(httpStatus, type, message) {
  return {
    httpStatus,
    body: Object.freeze({
      type: "error",
      error: Object.freeze({ type, message }),
    }),
  };
}

function gatewayMisconfigured() {
  // 500 with no detail: operator configuration problems (including
  // credentials) must never leak internals (§1.6).
  return errorResponse(500, "api_error", "internal_error", "Gateway misconfigured.");
}

function anthropicMisconfigured() {
  return anthropicError(500, "api_error", "Gateway misconfigured.");
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

function anthropicUnauthorized() {
  return {
    ...anthropicError(
      401,
      "authentication_error",
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

// Resolve the full fake text with retry strictly before the first byte: the
// caller renders SSE (or the JSON body) only after this resolves, so no
// retry can ever happen after streaming starts (§1.5). A shape mismatch
// (non-fake transport) is misconfiguration, not a retryable upstream error.
async function sendWithRetry(transport, request) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, result: await transport.send(request) };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError };
}

function checkFakeResult(transportResult) {
  return Boolean(
    transportResult &&
      transportResult.networkUsed === false &&
      typeof transportResult.output?.text === "string",
  );
}

// Normalize one message's content to plain text, or return an error
// descriptor. Only roles in `allowedRoles` with text content pass;
// image/audio parts fail closed with `unsupported_modality`.
function extractMessageText(message, index, allowedRoles = VALID_ROLES) {
  const label = `messages[${index}]`;
  if (!isPlainObject(message)) {
    return { ok: false, code: "invalid_messages", message: `${label} must be an object.` };
  }
  if (!allowedRoles.has(message.role)) {
    return {
      ok: false,
      code: "unsupported_role",
      message: `${label}.role must be one of ${[...allowedRoles].join(", ")}.`,
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

// Shared intake-cap normalization (TOG-7307): count cap first (structural),
// then per-message text caps over normalized text, then the combined cap.
// Returns neutral `{ok, messages} | {ok:false, code, message}` so each
// surface can wrap failures in its own envelope.
function normalizeIntake(rawMessages, allowedRoles) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return {
      ok: false,
      code: "invalid_messages",
      message: "Request messages must be a non-empty array.",
    };
  }
  if (rawMessages.length > MAX_GATEWAY_MESSAGES) {
    return {
      ok: false,
      code: "too_many_messages",
      message: `Request messages must contain at most ${MAX_GATEWAY_MESSAGES} messages.`,
    };
  }
  const normalizedMessages = [];
  for (const [index, message] of rawMessages.entries()) {
    const parsed = extractMessageText(message, index, allowedRoles);
    if (!parsed.ok) {
      return { ok: false, code: parsed.code, message: parsed.message };
    }
    if (parsed.text.length > MAX_GATEWAY_MESSAGE_CHARS) {
      return {
        ok: false,
        code: "message_too_large",
        message: `messages[${index}] must be at most ${MAX_GATEWAY_MESSAGE_CHARS} characters.`,
      };
    }
    normalizedMessages.push({ role: parsed.role, text: parsed.text });
  }
  let totalChars = 0;
  for (const message of normalizedMessages) {
    totalChars += message.text.length;
  }
  if (totalChars > MAX_GATEWAY_TOTAL_CHARS) {
    return {
      ok: false,
      code: "messages_too_large",
      message: `Request messages must total at most ${MAX_GATEWAY_TOTAL_CHARS} characters.`,
    };
  }
  return { ok: true, messages: normalizedMessages };
}

// Shared routing (§1.3): pinned exact match or auto. Returns a neutral
// outcome so each surface wraps failures in its own envelope.
function pickRoute({ evaluations, candidates, selectionRequest, eligibilityOptions, requestedModel }) {
  const eligible = evaluations.filter((evaluation) => evaluation.eligible);
  const pinned = evaluations.find((evaluation) => evaluation.routeId === requestedModel);

  if (pinned) {
    // Exact match pins: ineligible pins 400, never silent substitution.
    if (!pinned.eligible) {
      return {
        ok: false,
        code: "model_not_eligible",
        message: `Model '${requestedModel}' is not eligible for this request (${pinned.reasons.join(", ")}).`,
      };
    }
    return { ok: true, selectedRouteId: pinned.routeId, eligibleCount: eligible.length };
  }
  if (requestedModel === "auto" || !evaluations.some((e) => e.routeId === requestedModel)) {
    // "auto", plus any other string (keeps hardcoded clients working —
    // the requested string is echoed in wayselect.requestedModel).
    let selection;
    try {
      selection = selectRoute(candidates, selectionRequest, eligibilityOptions);
    } catch (error) {
      if (error instanceof EligibilityRequestError) {
        return { ok: false, misconfigured: true };
      }
      throw error;
    }
    if (selection.status !== "selected" || !selection.selected) {
      return { ok: false, code: "no_eligible_route", message: "No eligible route for this request." };
    }
    return {
      ok: true,
      selectedRouteId: selection.selected.routeId,
      eligibleCount: eligible.length,
    };
  }
  return { ok: false, code: "no_eligible_route", message: "No eligible route for this request." };
}

function buildSelectionRequest(candidates, requirements) {
  return Object.freeze({
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
}

function runEvaluations(candidates, selectionRequest, eligibilityOptions) {
  try {
    return {
      ok: true,
      evaluations: evaluateEligibility(candidates, selectionRequest, eligibilityOptions),
    };
  } catch (error) {
    // Operator/fixture data problems (malformed candidates or options) are
    // gateway misconfiguration: 500 with no detail, never a client 400.
    if (error instanceof EligibilityRequestError) {
      return { ok: false };
    }
    throw error;
  }
}

function invalidMaxTokens(value) {
  return !Number.isInteger(value) || value < 0;
}

// One normalized delta stream (§1.5): fixed-size character slices of the
// completion text. Both SSE renderers consume these slices.
function textDeltas(text) {
  const deltas = [];
  for (let index = 0; index < text.length; index += STREAM_SLICE_CHARS) {
    deltas.push(text.slice(index, index + STREAM_SLICE_CHARS));
  }
  return deltas;
}

function sseHeaders() {
  return Object.freeze({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
}

// OpenAI SSE (§1.5): `data: {chunk}` lines with `choices[].delta`, a
// terminal chunk carrying `finish_reason:"stop"` plus the `wayselect`
// extension alongside the compatible fields, then `data: [DONE]`.
function renderOpenAIStream({ completionId, created, model, text, wayselect }) {
  const lines = [];
  for (const delta of textDeltas(text)) {
    lines.push(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      })}`,
    );
  }
  lines.push(
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      wayselect,
    })}`,
  );
  lines.push("data: [DONE]");
  return `${lines.join("\n\n")}\n\n`;
}

// Anthropic SSE (§1.5): the `message_start` / `content_block_start` /
// `content_block_delta` / `content_block_stop` / `message_delta` /
// `message_stop` event sequence. `wayselect` rides on `message_start.message`
// alongside the compatible fields.
function renderAnthropicStream({ messageId, model, text, inputTokens, outputTokens, wayselect }) {
  const events = [];
  const emit = (event, data) => {
    events.push(`event: ${event}\ndata: ${JSON.stringify(data)}`);
  };
  emit("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      wayselect,
    },
  });
  emit("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const delta of textDeltas(text)) {
    emit("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: delta },
    });
  }
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: outputTokens },
  });
  emit("message_stop", { type: "message_stop" });
  return `${events.join("\n\n")}\n\n`;
}

function checkGatewayKey(gatewayKey, openai) {
  // Operator misconfiguration (including a missing expected key) fails
  // closed with no detail — never an auth bypass, never a leak (§1.6).
  if (typeof gatewayKey !== "string" || gatewayKey === "") {
    return openai ? gatewayMisconfigured() : anthropicMisconfigured();
  }
  return null;
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

  const keyError = checkGatewayKey(gatewayKey, true);
  if (keyError) {
    return keyError;
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

  // ---- messages (required, text-only v1; shared intake caps) ----
  const intake = normalizeIntake(body.messages, VALID_ROLES);
  if (!intake.ok) {
    return errorResponse(400, "invalid_request_error", intake.code, intake.message);
  }
  const normalizedMessages = intake.messages;

  // ---- streaming: validated here, rendered after routing+execution ----
  let streamRequested = false;
  if (body.stream !== undefined && body.stream !== false) {
    if (body.stream === true) {
      streamRequested = true;
    } else {
      return errorResponse(
        400,
        "invalid_request_error",
        "invalid_stream",
        "Request stream must be a boolean when present.",
      );
    }
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
  // Tool-call delta mapping is deferred (spec §5): tools + stream fails
  // closed on both surfaces (§1.5).
  if (streamRequested && toolCalling) {
    return errorResponse(
      400,
      "invalid_request_error",
      "streaming_tools_not_supported",
      "tools with stream:true is not supported in this slice (non-streaming only).",
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
  const selectionRequest = buildSelectionRequest(candidates, requirements);
  const evaluated = runEvaluations(candidates, selectionRequest, eligibilityOptions);
  if (!evaluated.ok) {
    return gatewayMisconfigured();
  }
  const routed = pickRoute({
    evaluations: evaluated.evaluations,
    candidates,
    selectionRequest,
    eligibilityOptions,
    requestedModel,
  });
  if (routed.misconfigured) {
    return gatewayMisconfigured();
  }
  if (!routed.ok) {
    return errorResponse(400, "invalid_request_error", routed.code, routed.message);
  }
  const { selectedRouteId } = routed;
  const eligibleCount = routed.eligibleCount;

  // ---- fake-backed execution: network use is forbidden in this slice ----
  const combinedPrompt = normalizedMessages
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  const sent = await sendWithRetry(activeTransport, {
    route: { routeId: selectedRouteId },
    payload: { prompt: combinedPrompt, messageCount: normalizedMessages.length },
  });
  if (!sent.ok) {
    return gatewayMisconfigured();
  }
  const transportResult = sent.result;
  if (!checkFakeResult(transportResult)) {
    // Phase invariant: only FakeTransport-shaped, offline results may
    // back this surface. Anything else is a misconfiguration, never spend.
    return gatewayMisconfigured();
  }

  const completionText = transportResult.output.text;
  const promptTokens = countWords(combinedPrompt);
  const completionTokens = countWords(completionText);

  const wayselect = Object.freeze({
    selectedRouteId,
    requestedModel,
    // Classification lands in a later phase; null means "not classified",
    // never a silent default tier.
    tier: null,
    classifierConfidence: null,
    eligibleCount,
    dryRun: true,
    synthetic: true,
  });

  if (streamRequested) {
    return {
      httpStatus: 200,
      headers: sseHeaders(),
      body: renderOpenAIStream({
        completionId: `chatcmpl-syn-${randomBytes(12).toString("hex")}`,
        created: Math.floor(Date.now() / 1000),
        model: selectedRouteId,
        text: completionText,
        wayselect,
      }),
    };
  }

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
      wayselect,
    }),
  };
}

// Normalize the Anthropic `system` prompt (§1.2): a string or an array of
// text blocks, folded into the prompt as a leading system message. Anything
// else fails closed.
function normalizeAnthropicSystem(system) {
  if (system === undefined) {
    return { ok: true, text: null };
  }
  if (typeof system === "string") {
    return { ok: true, text: system };
  }
  if (Array.isArray(system) && system.length > 0) {
    const texts = [];
    for (const [index, block] of system.entries()) {
      if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
        return {
          ok: false,
          message: `system[${index}] must be a text block with string text.`,
        };
      }
      texts.push(block.text);
    }
    return { ok: true, text: texts.join("") };
  }
  return { ok: false, message: "Request system must be a string or a non-empty array of text blocks." };
}

export async function handleMessagesRequest(input) {
  const { headers, body, gatewayKey, candidates, eligibilityOptions, transport } =
    input ?? {};

  // Programmer contract (mirrors the OpenAI surface): malformed wiring
  // throws; request-level problems return HTTP-shaped errors below.
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

  const keyError = checkGatewayKey(gatewayKey, false);
  if (keyError) {
    return keyError;
  }
  if (!keysEqual(bearerKey(headers), gatewayKey)) {
    return anthropicUnauthorized();
  }

  if (!isPlainObject(body)) {
    return anthropicError(400, "invalid_request_error", "Request body must be a JSON object.");
  }

  // ---- model (required; semantics per §1.3, shared with OpenAI) ----
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return anthropicError(
      400,
      "invalid_request_error",
      "Request model must be a non-empty string.",
    );
  }
  const requestedModel = body.model;

  // ---- max_tokens (required per Anthropic; feeds maxOutputTokens §2.3) ----
  if (body.max_tokens === undefined) {
    return anthropicError(
      400,
      "invalid_request_error",
      "Request max_tokens is required and must be a non-negative integer.",
    );
  }
  if (invalidMaxTokens(body.max_tokens)) {
    return anthropicError(
      400,
      "invalid_request_error",
      "Request max_tokens must be a non-negative integer.",
    );
  }
  const maxOutputTokens = body.max_tokens;

  // ---- messages (required, user/assistant text blocks; shared caps) ----
  const intake = normalizeIntake(body.messages, ANTHROPIC_ROLES);
  if (!intake.ok) {
    return anthropicError(400, "invalid_request_error", intake.message);
  }
  const normalizedMessages = intake.messages;

  // ---- system (optional prompt prefix, folded into caps + prompt) ----
  const system = normalizeAnthropicSystem(body.system);
  if (!system.ok) {
    return anthropicError(400, "invalid_request_error", system.message);
  }
  if (system.text !== null) {
    if (system.text.length > MAX_GATEWAY_MESSAGE_CHARS) {
      return anthropicError(
        400,
        "invalid_request_error",
        `system must be at most ${MAX_GATEWAY_MESSAGE_CHARS} characters.`,
      );
    }
    normalizedMessages.unshift({ role: "system", text: system.text });
    // The folded system prompt counts as a message: a full batch plus a
    // system prompt still fails closed on the count cap.
    if (normalizedMessages.length > MAX_GATEWAY_MESSAGES) {
      return anthropicError(
        400,
        "invalid_request_error",
        `Request messages must contain at most ${MAX_GATEWAY_MESSAGES} messages.`,
      );
    }
    let totalChars = 0;
    for (const message of normalizedMessages) {
      totalChars += message.text.length;
    }
    if (totalChars > MAX_GATEWAY_TOTAL_CHARS) {
      return anthropicError(
        400,
        "invalid_request_error",
        `Request messages must total at most ${MAX_GATEWAY_TOTAL_CHARS} characters.`,
      );
    }
  }

  // ---- streaming: validated here, rendered after routing+execution ----
  let streamRequested = false;
  if (body.stream !== undefined && body.stream !== false) {
    if (body.stream === true) {
      streamRequested = true;
    } else {
      return anthropicError(
        400,
        "invalid_request_error",
        "Request stream must be a boolean when present.",
      );
    }
  }

  // ---- tools (non-streaming only): feeds requirements.toolCalling (§2.3) ----
  let toolCalling = false;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return anthropicError(
        400,
        "invalid_request_error",
        "Request tools must be an array when present.",
      );
    }
    toolCalling = body.tools.length > 0;
  }
  if (body.tool_choice !== undefined && !toolCalling) {
    return anthropicError(
      400,
      "invalid_request_error",
      "Request tool_choice requires tools.",
    );
  }
  if (streamRequested && toolCalling) {
    return anthropicError(
      400,
      "invalid_request_error",
      "tools with stream:true is not supported in this slice (non-streaming only).",
    );
  }

  // ---- stop_sequences / temperature / top_p: accepted-and-ignored (§1.2) ----
  if (body.stop_sequences !== undefined) {
    if (
      !Array.isArray(body.stop_sequences) ||
      body.stop_sequences.some((entry) => typeof entry !== "string")
    ) {
      return anthropicError(
        400,
        "invalid_request_error",
        "Request stop_sequences must be an array of strings when present.",
      );
    }
  }

  const requirements = { maxOutputTokens };
  if (toolCalling) {
    requirements.toolCalling = true;
  }
  if (candidates.length === 0) {
    return anthropicError(400, "invalid_request_error", "No eligible route for this request.");
  }

  // ---- routing (§1.3): pinned exact match or auto ----
  const selectionRequest = buildSelectionRequest(candidates, requirements);
  const evaluated = runEvaluations(candidates, selectionRequest, eligibilityOptions);
  if (!evaluated.ok) {
    return anthropicMisconfigured();
  }
  const routed = pickRoute({
    evaluations: evaluated.evaluations,
    candidates,
    selectionRequest,
    eligibilityOptions,
    requestedModel,
  });
  if (routed.misconfigured) {
    return anthropicMisconfigured();
  }
  if (!routed.ok) {
    return anthropicError(400, "invalid_request_error", routed.message);
  }
  const { selectedRouteId } = routed;
  const eligibleCount = routed.eligibleCount;

  // ---- fake-backed execution: network use is forbidden in this slice ----
  const combinedPrompt = normalizedMessages
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  const sent = await sendWithRetry(activeTransport, {
    route: { routeId: selectedRouteId },
    payload: { prompt: combinedPrompt, messageCount: normalizedMessages.length },
  });
  if (!sent.ok) {
    return anthropicMisconfigured();
  }
  const transportResult = sent.result;
  if (!checkFakeResult(transportResult)) {
    return anthropicMisconfigured();
  }

  const completionText = transportResult.output.text;
  const inputTokens = countWords(combinedPrompt);
  const outputTokens = countWords(completionText);

  const wayselect = Object.freeze({
    selectedRouteId,
    requestedModel,
    // Classification lands in a later phase; null means "not classified",
    // never a silent default tier.
    tier: null,
    classifierConfidence: null,
    eligibleCount,
    dryRun: true,
    synthetic: true,
  });

  if (streamRequested) {
    return {
      httpStatus: 200,
      headers: sseHeaders(),
      body: renderAnthropicStream({
        messageId: `msg-syn-${randomBytes(12).toString("hex")}`,
        model: selectedRouteId,
        text: completionText,
        inputTokens,
        outputTokens,
        wayselect,
      }),
    };
  }

  return {
    httpStatus: 200,
    body: Object.freeze({
      id: `msg-syn-${randomBytes(12).toString("hex")}`,
      type: "message",
      role: "assistant",
      model: selectedRouteId,
      content: Object.freeze([
        Object.freeze({ type: "text", text: completionText }),
      ]),
      stop_reason: "end_turn",
      stop_sequence: null,
      // Synthetic estimates (whitespace counts), never tokenizer output.
      usage: Object.freeze({ input_tokens: inputTokens, output_tokens: outputTokens }),
      wayselect,
    }),
  };
}
