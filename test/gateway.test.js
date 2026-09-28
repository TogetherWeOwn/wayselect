// Conformance for the Phase-1 OpenAI chat-completions skeleton (TOG-5951,
// gateway spec TOG-5939 §1.1/§1.3/§1.6).
//
// Covers the spec's §4 acceptance rows: auto-route, pinned-eligible,
// pinned-ineligible 400, no-eligible-route 400, 401 cases — plus the
// model-fallback, error-table, and synthetic-labeling adjacents the README
// claim ("synthetic-only") rests on.
//
// Offline by construction: globalThis.fetch is stubbed to throw, and every
// request exercises the in-process handler with fixture candidates (no
// sockets, no network, no credentials on disk).

import test from "node:test";
import assert from "node:assert/strict";
import { handleChatCompletionsRequest } from "../src/gateway.js";
import { FakeTransport } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const GATEWAY_KEY = "test-gateway-key";

let sharedCandidates = null;
async function candidates() {
  sharedCandidates ??= (await loadConfiguredCandidates()).candidates;
  return sharedCandidates;
}

const baseMessages = Object.freeze([
  Object.freeze({ role: "system", content: "You are a test assistant." }),
  Object.freeze({ role: "user", content: "Say hello." }),
]);

function chatBody(overrides = {}) {
  return { model: "auto", messages: structuredClone(baseMessages), ...overrides };
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
    throw new Error("network access is forbidden in gateway conformance");
  });
}

test("G1 auto-route selects the cheapest eligible route with synthetic labeling", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), transport }),
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.object, "chat.completion");
  // Cheapest eligible under the empty-requirement baseline: unknown-tools
  // carries the lowest synthetic rate and no constraint excludes it (the
  // existing boundary only fails closed on dimensions a requirement
  // constrains). Deterministic per the shared price-then-lexicographic policy.
  assert.equal(result.body.model, "northstar/unknown-tools");
  assert.equal(result.body.choices.length, 1);
  assert.equal(result.body.choices[0].message.role, "assistant");
  assert.equal(result.body.choices[0].finish_reason, "stop");
  assert.match(result.body.choices[0].message.content, /Synthetic response from/);
  assert.equal(result.body.wayselect.selectedRouteId, "northstar/unknown-tools");
  assert.equal(result.body.wayselect.requestedModel, "auto");
  assert.equal(result.body.wayselect.dryRun, true);
  assert.equal(result.body.wayselect.synthetic, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].routeId, "northstar/unknown-tools");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G2 pinned-eligible model serves the pinned route", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({ model: "orbit/orbit-chat" }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.model, "orbit/orbit-chat");
  assert.equal(result.body.wayselect.selectedRouteId, "orbit/orbit-chat");
  assert.equal(result.body.wayselect.requestedModel, "orbit/orbit-chat");
  assert.equal(result.body.wayselect.dryRun, true);
  assert.equal(result.body.wayselect.synthetic, true);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G3 pinned-ineligible model returns 400 model_not_eligible", async (context) => {
  noNetwork(context);
  const transport = new FakeTransport();
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      transport,
      body: chatBody({ model: "orbit/retired-chat" }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.code, "model_not_eligible");
  assert.match(result.body.error.message, /orbit\/retired-chat/);
  // Never substituted, never attempted: no transport call on the 400 path.
  assert.equal(transport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G4 unsatisfiable typed requirements yield 400 no_eligible_route", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({
        model: "auto",
        response_format: { type: "json_object" },
        max_tokens: 50,
      }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.code, "no_eligible_route");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G5 missing gateway key returns the exact 401 contract (status/body/header)", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), headers: {} }),
  );

  assert.equal(result.httpStatus, 401);
  // Exact body bytes: an added, dropped, or reworded field fails here, not
  // on a gateway client.
  assert.deepStrictEqual(result.body, {
    error: {
      message: "Invalid or missing gateway credentials.",
      type: "authentication_error",
      code: "invalid_api_key",
    },
  });
  assert.deepStrictEqual(Object.keys(result.body.error).sort(), ["code", "message", "type"]);
  // RFC 9110 auth challenge rides on the 401; a future HTTP binding
  // forwards `headers` verbatim alongside `httpStatus`/`body`.
  assert.deepStrictEqual(result.headers, { "WWW-Authenticate": "Bearer" });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G6 wrong gateway key returns a 401 byte-identical to the missing key", async (context) => {
  noNetwork(context);
  const all = await candidates();
  const missing = await handleChatCompletionsRequest(
    chatRequest({ candidates: all, headers: {} }),
  );
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: all,
      headers: { authorization: "Bearer wrong-key" },
    }),
  );

  assert.equal(result.httpStatus, 401);
  assert.equal(result.body.error.type, "authentication_error");
  assert.equal(result.body.error.code, "invalid_api_key");
  // No credential oracle: missing and wrong keys are indistinguishable
  // (status, body, and headers all identical).
  assert.deepStrictEqual(result, missing);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G7 unknown model strings fall back to auto and echo the request", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({ model: "some-hardcoded-client-model" }),
    }),
  );

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.model, "northstar/unknown-tools");
  assert.equal(result.body.wayselect.requestedModel, "some-hardcoded-client-model");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G8 missing model returns 400", async (context) => {
  noNetwork(context);
  const body = chatBody();
  delete body.model;
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), body }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G9 image content parts return 400 unsupported_modality", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({
      candidates: await candidates(),
      body: chatBody({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this." },
              { type: "image_url", image_url: { url: "https://example.invalid/x.png" } },
            ],
          },
        ],
      }),
    }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.code, "unsupported_modality");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G10 stream:true returns 400 (non-streaming only in this slice)", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), body: chatBody({ stream: true }) }),
  );

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G11 n>1, logprobs, and legacy functions return 400", async (context) => {
  noNetwork(context);
  const all = await candidates();
  for (const extra of [{ n: 2 }, { logprobs: true }, { functions: [] }]) {
    const result = await handleChatCompletionsRequest(
      chatRequest({ candidates: all, body: chatBody(extra) }),
    );
    assert.equal(result.httpStatus, 400, JSON.stringify(extra));
    assert.equal(result.body.error.type, "invalid_request_error");
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G12 misconfigured gateway (no expected key) returns 500 without detail", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), gatewayKey: "" }),
  );

  assert.equal(result.httpStatus, 500);
  assert.equal(result.body.error.type, "api_error");
  assert.doesNotMatch(JSON.stringify(result.body), /test-gateway-key/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G13 a network-claiming transport cannot back this surface (500)", async (context) => {
  noNetwork(context);
  const networked = {
    async send() {
      return { networkUsed: true, output: { text: "live text" } };
    },
  };
  const result = await handleChatCompletionsRequest(
    chatRequest({ candidates: await candidates(), transport: networked }),
  );

  assert.equal(result.httpStatus, 500);
  assert.equal(result.body.error.type, "api_error");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("G14 empty candidate set returns 400 no_eligible_route", async (context) => {
  noNetwork(context);
  const result = await handleChatCompletionsRequest(chatRequest({ candidates: [] }));

  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.code, "no_eligible_route");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
