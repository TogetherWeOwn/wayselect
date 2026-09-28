// Conformance for the Phase-2 Anthropic surface + streaming SSE (TOG-5956,
// gateway spec TOG-5939 §1.2/§1.3/§1.5/§1.6).
//
// Covers: Anthropic non-streaming (§1.2 — required max_tokens, text blocks
// only, system prompt, shared §1.3 model semantics, Anthropic error
// envelope), OpenAI SSE and Anthropic SSE byte shapes (§1.5 — terminators
// `data: [DONE]` / `message_stop`, one normalized delta stream), the
// `tools`+`stream` 400 on both surfaces, and first-byte/no-retry behavior
// under a killed upstream (fake).
//
// Offline by construction: globalThis.fetch is stubbed to throw, and every
// request exercises the in-process handlers with fixture candidates (no
// sockets, no network, no credentials on disk).
//
// Fixture note: no fixture candidate declares `limits.maxOutputTokens`, so
// Anthropic's required `max_tokens` (which feeds
// `requirements.maxOutputTokens`) fails closed on bare fixtures — the same
// boundary Phase-1 G4 pins. Tests needing a 200 pin it through
// limit-declaring candidate clones; the bare-fixture 400 is asserted too.

import test from "node:test";
import assert from "node:assert/strict";
import { handleChatCompletionsRequest, handleMessagesRequest } from "../src/gateway.js";
import { FakeTransport } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const GATEWAY_KEY = "test-gateway-phase2-key";

let sharedCandidates = null;
async function candidates() {
  sharedCandidates ??= (await loadConfiguredCandidates()).candidates;
  return sharedCandidates;
}

// Clone fixture candidates with a declared output limit so Anthropic's
// required max_tokens can route. Input candidates are never mutated.
function withOutputLimit(all, maxOutputTokens = 4096) {
  return all.map((candidate) => ({
    ...candidate,
    limits: { ...(candidate.limits ?? {}), maxOutputTokens },
  }));
}

function messagesBody(overrides = {}) {
  return {
    model: "auto",
    max_tokens: 256,
    messages: [{ role: "user", content: "Say hello." }],
    ...overrides,
  };
}

function messagesRequest(overrides = {}) {
  return {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: messagesBody(),
    gatewayKey: GATEWAY_KEY,
    eligibilityOptions: evaluationOptions,
    ...overrides,
  };
}

function chatBody(overrides = {}) {
  return {
    model: "auto",
    messages: [{ role: "user", content: "Say hello." }],
    ...overrides,
  };
}

function chatRequest(overrides = {}) {
  return {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: chatBody(),
    gatewayKey: GATEWAY_KEY,
    eligibilityOptions: evaluationOptions,
    ...overrides,
  };
}

function noNetwork(context) {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("network access is forbidden in gateway phase-2 conformance");
  });
}

function killingTransport(counter) {
  return {
    async send() {
      counter.calls += 1;
      throw new Error("upstream is down");
    },
  };
}

// Split an OpenAI SSE body into its chunk payloads, pinning the terminal
// `data: [DONE]` line.
function parseOpenAIStream(body) {
  assert.equal(typeof body, "string");
  const frames = body.split("\n\n").filter(Boolean);
  assert.ok(frames.length >= 2, "stream carries deltas plus the terminator");
  assert.equal(frames.at(-1), "data: [DONE]");
  return frames.slice(0, -1).map((frame) => {
    assert.ok(frame.startsWith("data: "), `frame starts with data: — ${frame.slice(0, 40)}`);
    return JSON.parse(frame.slice("data: ".length));
  });
}

// Split an Anthropic SSE body into ordered (event, data) pairs.
function parseAnthropicStream(body) {
  assert.equal(typeof body, "string");
  const frames = body.split("\n\n").filter(Boolean);
  assert.ok(frames.length >= 2, "stream carries events");
  return frames.map((frame) => {
    const [eventLine, dataLine] = frame.split("\n");
    assert.ok(eventLine.startsWith("event: "), `event line — ${frame.slice(0, 60)}`);
    assert.ok(dataLine.startsWith("data: "), `data line — ${frame.slice(0, 60)}`);
    return {
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    };
  });
}

function assertAnthropicEnvelope(resultBody) {
  assert.deepStrictEqual(Object.keys(resultBody).sort(), ["error", "type"]);
  assert.equal(resultBody.type, "error");
  // The vendor envelope carries no `code` — codes stay OpenAI-surface-only.
  assert.deepStrictEqual(Object.keys(resultBody.error).sort(), ["message", "type"]);
}

// ---- Anthropic non-streaming (§1.2) ----

test("M1 anthropic auto-route returns a synthetic dry-run message", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleMessagesRequest(
    messagesRequest({ candidates: withOutputLimit(await candidates()), transport }),
  );

  assert.equal(result.httpStatus, 200);
  assert.match(result.body.id, /^msg-syn-/);
  assert.equal(result.body.type, "message");
  assert.equal(result.body.role, "assistant");
  assert.equal(result.body.model, "northstar/unknown-tools");
  assert.deepStrictEqual(Object.keys(result.body.content[0]).sort(), ["text", "type"]);
  assert.equal(result.body.content[0].type, "text");
  assert.match(result.body.content[0].text, /Synthetic response from northstar\/unknown-tools/);
  assert.equal(result.body.stop_reason, "end_turn");
  assert.equal(result.body.stop_sequence, null);
  assert.ok(result.body.usage.input_tokens > 0);
  assert.ok(result.body.usage.output_tokens > 0);
  assert.equal(result.body.wayselect.selectedRouteId, "northstar/unknown-tools");
  assert.equal(result.body.wayselect.requestedModel, "auto");
  assert.equal(result.body.wayselect.tier, null);
  assert.equal(result.body.wayselect.classifierConfidence, null);
  assert.equal(result.body.wayselect.dryRun, true);
  assert.equal(result.body.wayselect.synthetic, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].routeId, "northstar/unknown-tools");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M2 anthropic missing max_tokens returns 400 (required per Anthropic)", async (context) => {
  noNetwork(context);
  const body = messagesBody();
  delete body.max_tokens;
  const result = await handleMessagesRequest(
    messagesRequest({ candidates: withOutputLimit(await candidates()), body }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assertAnthropicEnvelope(result.body);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M3 anthropic bare fixtures fail closed on required max_tokens (G4 boundary)", async (context) => {
  noNetwork(context);
  // No fixture candidate declares limits.maxOutputTokens, so the required
  // max_tokens feeds a requirement nothing satisfies — 400, never a silent
  // pass with the limit ignored.
  const result = await handleMessagesRequest(
    messagesRequest({ candidates: await candidates() }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assertAnthropicEnvelope(result.body);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M4 anthropic pinned-eligible serves the pinned route", async (context) => {
  noNetwork(context);
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      body: messagesBody({ model: "orbit/orbit-chat" }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.model, "orbit/orbit-chat");
  assert.equal(result.body.wayselect.requestedModel, "orbit/orbit-chat");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M5 anthropic pinned-ineligible returns 400, never substituted", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      transport,
      body: messagesBody({ model: "orbit/retired-chat" }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.match(result.body.error.message, /orbit\/retired-chat/);
  assertAnthropicEnvelope(result.body);
  assert.equal(transport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M6 anthropic unknown model strings fall back to auto and echo", async (context) => {
  noNetwork(context);
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      body: messagesBody({ model: "some-hardcoded-client-model" }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.model, "northstar/unknown-tools");
  assert.equal(result.body.wayselect.requestedModel, "some-hardcoded-client-model");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M7 anthropic 401s are byte-identical with the auth challenge", async (context) => {
  noNetwork(context);
  const all = withOutputLimit(await candidates());
  const missing = await handleMessagesRequest(messagesRequest({ candidates: all, headers: {} }));
  const wrong = await handleMessagesRequest(
    messagesRequest({ candidates: all, headers: { authorization: "Bearer wrong-key" } }),
  );

  assert.equal(missing.httpStatus, 401);
  assert.deepStrictEqual(missing.body, {
    type: "error",
    error: {
      type: "authentication_error",
      message: "Invalid or missing gateway credentials.",
    },
  });
  assertAnthropicEnvelope(missing.body);
  assert.deepStrictEqual(missing.headers, { "WWW-Authenticate": "Bearer" });
  assert.deepStrictEqual(wrong, missing);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M8 anthropic system role in messages returns 400 (user/assistant only)", async (context) => {
  noNetwork(context);
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      body: messagesBody({
        messages: [{ role: "system", content: "You are helpful." }],
      }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assertAnthropicEnvelope(result.body);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M9 anthropic system prompt folds into the transport payload", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      transport,
      body: messagesBody({ system: "You are helpful." }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.ok(
    transport.calls[0].payload.prompt.startsWith("system: You are helpful.\nuser: Say hello."),
    JSON.stringify(transport.calls[0].payload.prompt),
  );
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M10 anthropic system text-block array folds to joined text", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      transport,
      body: messagesBody({
        system: [
          { type: "text", text: "Be brief." },
          { type: "text", text: "Be kind." },
        ],
      }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.ok(
    transport.calls[0].payload.prompt.startsWith("system: Be brief.Be kind."),
    JSON.stringify(transport.calls[0].payload.prompt),
  );
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M11 anthropic malformed system and image parts return 400", async (context) => {
  noNetwork(context);
  const all = withOutputLimit(await candidates());
  for (const extra of [
    { system: 42 },
    { system: [{ type: "image", source: {} }] },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            { type: "image_url", image_url: { url: "https://example.invalid/x.png" } },
          ],
        },
      ],
    },
  ]) {
    const result = await handleMessagesRequest(
      messagesRequest({ candidates: all, body: messagesBody(extra) }),
    );
    assert.equal(result.httpStatus, 400, JSON.stringify(extra));
    assert.equal(result.body.error.type, "invalid_request_error");
    assertAnthropicEnvelope(result.body);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M12 anthropic tools feed the requirement; tool_choice needs tools", async (context) => {
  noNetwork(context);
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      body: messagesBody({ tools: [{ name: "get_time" }] }),
    }),
  );

  // unknown-tools carries no toolUse data (fails closed on the flag), so the
  // routed model must be a tool-capable route, never the auto baseline.
  assert.equal(result.httpStatus, 200);
  assert.notEqual(result.body.model, "northstar/unknown-tools");
  assert.ok(["legacy/old-chat", "northstar/alpha-chat", "orbit/orbit-chat"].includes(result.body.model));

  const dangling = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      body: messagesBody({ tool_choice: { type: "auto" } }),
    }),
  );
  assert.equal(dangling.httpStatus, 400);
  assert.equal(dangling.body.error.type, "invalid_request_error");
  assertAnthropicEnvelope(dangling.body);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M13 anthropic intake caps and bad stream/stop_sequences fail closed", async (context) => {
  noNetwork(context);
  const all = withOutputLimit(await candidates());
  const overCount = Array.from({ length: 33 }, (_, i) => ({ role: "user", content: `ping ${i}` }));
  for (const extra of [
    { messages: overCount },
    { stream: "yes" },
    { stop_sequences: "stop" },
    { stop_sequences: [42] },
    { max_tokens: -1 },
  ]) {
    const result = await handleMessagesRequest(
      messagesRequest({ candidates: all, body: messagesBody(extra) }),
    );
    assert.equal(result.httpStatus, 400, JSON.stringify(extra).slice(0, 80));
    assert.equal(result.body.error.type, "invalid_request_error");
    assertAnthropicEnvelope(result.body);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M14 anthropic misconfiguration and networked transport return 500 without detail", async (context) => {
  noNetwork(context);
  const all = withOutputLimit(await candidates());
  const misconfigured = await handleMessagesRequest(
    messagesRequest({ candidates: all, gatewayKey: "" }),
  );
  assert.equal(misconfigured.httpStatus, 500);
  assert.equal(misconfigured.body.error.type, "api_error");
  assertAnthropicEnvelope(misconfigured.body);

  const networked = {
    async send() {
      return { networkUsed: true, output: { text: "live text" } };
    },
  };
  const live = await handleMessagesRequest(
    messagesRequest({ candidates: all, transport: networked }),
  );
  assert.equal(live.httpStatus, 500);
  assert.equal(live.body.error.type, "api_error");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("M15 anthropic handler leaks no key material and logs nothing", async (context) => {
  const operatorKey = "op-5956-operator-secret-4d2c9e1a7b.invalid";
  const all = withOutputLimit(await candidates());
  const request = (overrides = {}) =>
    messagesRequest({ candidates: all, gatewayKey: operatorKey, ...overrides });
  const keyless = (result, label) => {
    const text = JSON.stringify({ body: result.body, headers: result.headers ?? {} });
    assert.ok(!text.includes(operatorKey), `${label} must not contain the operator key`);
  };

  const good = {
    headers: { authorization: `Bearer ${operatorKey}` },
  };
  const bodies = [
    messagesBody(),
    messagesBody({ model: "orbit/retired-chat" }),
    messagesBody({ max_tokens: undefined }),
    messagesBody({ system: 42 }),
    messagesBody({ stream: true, tools: [{ name: "get_time" }] }),
  ];
  delete bodies[2].max_tokens;
  const captured = [];
  const methods = ["log", "error", "warn", "debug", "info"];
  const originals = new Map(methods.map((method) => [method, console[method]]));
  for (const method of methods) {
    console[method] = (...args) => captured.push([method, ...args]);
  }
  try {
    keyless(await handleMessagesRequest(request(good)), "200 message");
    for (const [index, body] of bodies.entries()) {
      keyless(await handleMessagesRequest(request({ body })), `error path ${index}`);
    }
    keyless(await handleMessagesRequest(request({ headers: {} })), "401 missing key");
    keyless(
      await handleMessagesRequest(
        request({ headers: { authorization: "Bearer wrong-key" } }),
      ),
      "401 wrong key",
    );
  } finally {
    for (const [method, fn] of originals) {
      console[method] = fn;
    }
  }
  assert.equal(captured.length, 0, "anthropic handler must not write to console");
});

// ---- OpenAI SSE (§1.5) ----

test("OS1 openai stream returns SSE deltas plus terminal chunk and [DONE]", async (context) => {
  noNetwork(context);
  const all = await candidates();
  const transport = new FakeTransport();
  const streamed = await handleChatCompletionsRequest(
    chatRequest({ candidates: all, transport, body: chatBody({ stream: true }) }),
  );

  assert.equal(streamed.httpStatus, 200);
  assert.deepStrictEqual(streamed.headers, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const chunks = parseOpenAIStream(streamed.body);
  assert.ok(chunks.length >= 2, "at least one delta plus the terminal chunk");
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(typeof chunk.choices[0].delta.content, "string");
    assert.equal(chunk.choices[0].finish_reason, null);
  }
  const terminal = chunks.at(-1);
  assert.deepStrictEqual(terminal.choices[0].delta, {});
  assert.equal(terminal.choices[0].finish_reason, "stop");
  assert.equal(terminal.wayselect.dryRun, true);
  assert.equal(terminal.wayselect.synthetic, true);

  // Deltas reassemble to exactly the non-streaming completion text: one
  // normalized stream, two renderings.
  const plain = await handleChatCompletionsRequest(
    chatRequest({ candidates: all, body: chatBody() }),
  );
  const reassembled = chunks
    .slice(0, -1)
    .map((chunk) => chunk.choices[0].delta.content)
    .join("");
  assert.equal(reassembled, plain.body.choices[0].message.content);
  assert.match(reassembled, /Synthetic response from/);
  assert.equal(streamed.body.endsWith("data: [DONE]\n\n"), true);
  assert.equal(transport.calls.length, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("OS2 openai empty tools array still streams (no tool-call deltas)", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({ stream: true, tools: [] }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.ok(result.body.endsWith("data: [DONE]\n\n"));
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("OS3 openai tools plus stream returns 400", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      transport,
      body: chatBody({ stream: true, tools: [{ type: "function", function: { name: "get_time" } }] }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.code, "streaming_tools_not_supported");
  assert.equal(transport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("OS4 openai stream honors typed requirements before the first byte", async (context) => {
  noNetwork(context);
  // Bare fixtures carry no maxOutputTokens data: a streamed request with
  // max_tokens fails closed with 400, never a partial SSE stream.
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({ stream: true, max_tokens: 50 }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.code, "no_eligible_route");
  assert.equal(typeof result.body, "object");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("OS5 openai killed upstream retries before the first byte, never mid-stream", async (context) => {
  noNetwork(context);
  const counter = { calls: 0 };
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      transport: killingTransport(counter),
      body: chatBody({ stream: true }),
    }),
  );

  assert.equal(result.httpStatus, 500);
  assert.equal(result.body.error.type, "api_error");
  // Retry budget exhausted upstream of rendering: attempts happened, but the
  // caller gets one error object — never a partial stream plus a retry.
  assert.equal(counter.calls, 3);
  assert.equal(typeof result.body, "object");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

// ---- Anthropic SSE (§1.5) ----

test("AS1 anthropic stream emits the full event sequence ending in message_stop", async (context) => {
  noNetwork(context);
  const all = withOutputLimit(await candidates());
  const transport = new FakeTransport();
  const streamed = await handleMessagesRequest(
    messagesRequest({ candidates: all, transport, body: messagesBody({ stream: true }) }),
  );

  assert.equal(streamed.httpStatus, 200);
  assert.deepStrictEqual(streamed.headers, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const events = parseAnthropicStream(streamed.body);
  const names = events.map((entry) => entry.event);
  assert.equal(names[0], "message_start");
  assert.equal(names[1], "content_block_start");
  assert.equal(names.at(-2), "message_delta");
  assert.equal(names.at(-1), "message_stop");
  assert.deepStrictEqual(names.slice(0, 2).concat(names.slice(-2)), [
    "message_start",
    "content_block_start",
    "message_delta",
    "message_stop",
  ]);
  const middle = names.slice(2, -2);
  assert.ok(middle.length >= 2, "at least one delta and the block stop");
  assert.equal(middle.at(-1), "content_block_stop");
  for (const name of middle.slice(0, -1)) {
    assert.equal(name, "content_block_delta");
  }

  const start = events[0].data;
  assert.equal(start.type, "message_start");
  assert.match(start.message.id, /^msg-syn-/);
  assert.equal(start.message.model, "northstar/unknown-tools");
  assert.equal(start.message.wayselect.dryRun, true);
  assert.equal(start.message.wayselect.synthetic, true);

  const deltaTexts = events
    .filter((entry) => entry.event === "content_block_delta")
    .map((entry) => {
      assert.equal(entry.data.delta.type, "text_delta");
      return entry.data.delta.text;
    });

  // Deltas reassemble to exactly the non-streaming message text.
  const plain = await handleMessagesRequest(
    messagesRequest({ candidates: all, body: messagesBody() }),
  );
  assert.equal(deltaTexts.join(""), plain.body.content[0].text);
  assert.match(deltaTexts.join(""), /Synthetic response from/);
  assert.equal(events.at(-1).data.type, "message_stop");
  assert.equal(events.at(-2).data.delta.stop_reason, "end_turn");
  assert.equal(events.at(-2).data.usage.output_tokens, plain.body.usage.output_tokens);
  assert.equal(transport.calls.length, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("AS2 anthropic tools plus stream returns 400", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      transport,
      body: messagesBody({ stream: true, tools: [{ name: "get_time" }] }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assertAnthropicEnvelope(result.body);
  assert.equal(transport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("AS3 anthropic killed upstream retries before the first byte, never mid-stream", async (context) => {
  noNetwork(context);
  const counter = { calls: 0 };
  const result = await handleMessagesRequest(
    messagesRequest({
      candidates: withOutputLimit(await candidates()),
      transport: killingTransport(counter),
      body: messagesBody({ stream: true }),
    }),
  );

  assert.equal(result.httpStatus, 500);
  assert.equal(result.body.error.type, "api_error");
  assertAnthropicEnvelope(result.body);
  assert.equal(counter.calls, 3);
  assert.equal(typeof result.body, "object");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
