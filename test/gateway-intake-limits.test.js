// Gateway intake-limits enforcement matrix (TOG-7307).
//
// Pins the src/intakeLimits.js caps in the in-process chat-completions
// handler (src/gateway.js): at most MAX_GATEWAY_MESSAGES messages, at most
// MAX_GATEWAY_MESSAGE_CHARS chars per normalized message text, at most
// MAX_GATEWAY_TOTAL_CHARS chars combined. Each cap gets a pass row (exact
// boundary serves 200) and a reject row (one over fails closed with 400
// `invalid_request_error` and a static code), plus a joined-parts row proving
// the per-message cap measures normalized text. node:test, zero
// dependencies, no network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeTransport,
  MAX_GATEWAY_MESSAGE_CHARS,
  MAX_GATEWAY_MESSAGES,
  MAX_GATEWAY_TOTAL_CHARS,
  handleChatCompletionsRequest,
} from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

const GATEWAY_KEY = "test-gateway-intake-limits-key";

let sharedCandidates = null;
async function candidates() {
  sharedCandidates ??= (await loadConfiguredCandidates()).candidates;
  return sharedCandidates;
}

function chatRequest(messages, overrides = {}) {
  return {
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: "auto", messages },
    gatewayKey: GATEWAY_KEY,
    eligibilityOptions: evaluationOptions,
    ...overrides,
  };
}

function tinyMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    role: "user",
    content: `ping ${i}`,
  }));
}

function noNetwork(context) {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("network access is forbidden in gateway intake-limits conformance");
  });
}

test("caps are pinned: 32 messages, 16k per message, 64k total", () => {
  assert.equal(MAX_GATEWAY_MESSAGES, 32);
  assert.equal(MAX_GATEWAY_MESSAGE_CHARS, 16_000);
  assert.equal(MAX_GATEWAY_TOTAL_CHARS, 64_000);
});

test("count cap: exactly 32 messages pass, 33 fail closed", async (context) => {
  noNetwork(context);
  const all = await candidates();

  const transport = new FakeTransport();
  const pass = await handleChatCompletionsRequest(
    chatRequest(tinyMessages(MAX_GATEWAY_MESSAGES), { candidates: all, transport }),
  );
  assert.equal(pass.httpStatus, 200, JSON.stringify(pass.body?.error));
  assert.equal(transport.calls.length, 1);

  const rejectTransport = new FakeTransport();
  const reject = await handleChatCompletionsRequest(
    chatRequest(tinyMessages(MAX_GATEWAY_MESSAGES + 1), {
      candidates: all,
      transport: rejectTransport,
    }),
  );
  assert.equal(reject.httpStatus, 400);
  assert.equal(reject.body.error.type, "invalid_request_error");
  assert.equal(reject.body.error.code, "too_many_messages");
  assert.equal(
    reject.body.error.message,
    `Request messages must contain at most ${MAX_GATEWAY_MESSAGES} messages.`,
  );
  assert.equal(rejectTransport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("per-message cap: exactly 16k chars pass, 16k+1 fail closed", async (context) => {
  noNetwork(context);
  const all = await candidates();

  const pass = await handleChatCompletionsRequest(
    chatRequest(
      [{ role: "user", content: "x".repeat(MAX_GATEWAY_MESSAGE_CHARS) }],
      { candidates: all, transport: new FakeTransport() },
    ),
  );
  assert.equal(pass.httpStatus, 200, JSON.stringify(pass.body?.error));

  const rejectTransport = new FakeTransport();
  const reject = await handleChatCompletionsRequest(
    chatRequest(
      [{ role: "user", content: "x".repeat(MAX_GATEWAY_MESSAGE_CHARS + 1) }],
      { candidates: all, transport: rejectTransport },
    ),
  );
  assert.equal(reject.httpStatus, 400);
  assert.equal(reject.body.error.type, "invalid_request_error");
  assert.equal(reject.body.error.code, "message_too_large");
  assert.equal(
    reject.body.error.message,
    `messages[0] must be at most ${MAX_GATEWAY_MESSAGE_CHARS} characters.`,
  );
  assert.equal(rejectTransport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("per-message cap measures joined text parts, not individual parts", async (context) => {
  noNetwork(context);
  const all = await candidates();

  // Each part is under the cap, but the joined text (18k) exceeds it.
  const half = "y".repeat(9_000);
  const reject = await handleChatCompletionsRequest(
    chatRequest(
      [
        {
          role: "user",
          content: [
            { type: "text", text: half },
            { type: "text", text: half },
          ],
        },
      ],
      { candidates: all, transport: new FakeTransport() },
    ),
  );
  assert.equal(reject.httpStatus, 400);
  assert.equal(reject.body.error.type, "invalid_request_error");
  assert.equal(reject.body.error.code, "message_too_large");
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("total cap: exactly 64k combined chars pass, over fails closed", async (context) => {
  noNetwork(context);
  const all = await candidates();

  // 4 × 16k: every message at its per-message boundary and the combined
  // text exactly at the total boundary.
  const atBoundary = Array.from({ length: 4 }, () => ({
    role: "user",
    content: "z".repeat(MAX_GATEWAY_MESSAGE_CHARS),
  }));
  const pass = await handleChatCompletionsRequest(
    chatRequest(atBoundary, { candidates: all, transport: new FakeTransport() }),
  );
  assert.equal(pass.httpStatus, 200, JSON.stringify(pass.body?.error));

  // 5 × 16k: each message within its own cap, combined text (80k) over.
  const over = Array.from({ length: 5 }, () => ({
    role: "user",
    content: "z".repeat(MAX_GATEWAY_MESSAGE_CHARS),
  }));
  assert.ok(
    5 * MAX_GATEWAY_MESSAGE_CHARS > MAX_GATEWAY_TOTAL_CHARS,
    "fixture must isolate the total cap from the per-message cap",
  );
  const rejectTransport = new FakeTransport();
  const reject = await handleChatCompletionsRequest(
    chatRequest(over, { candidates: all, transport: rejectTransport }),
  );
  assert.equal(reject.httpStatus, 400);
  assert.equal(reject.body.error.type, "invalid_request_error");
  assert.equal(reject.body.error.code, "messages_too_large");
  assert.equal(
    reject.body.error.message,
    `Request messages must total at most ${MAX_GATEWAY_TOTAL_CHARS} characters.`,
  );
  assert.equal(rejectTransport.calls.length, 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
