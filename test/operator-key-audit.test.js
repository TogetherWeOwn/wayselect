// Operator-key handling audit (TOG-7271).
//
// The Phase-1 gateway handler verifies an operator-held bearer key at call
// time. That key must never appear in logs, error bodies, transport records,
// or snapshots: every error path returns a static message, auth failures are
// byte-identical (no credential oracle), and the comparison stays
// timing-safe. A regression that interpolates key material into any output,
// adds a logging sink to the gateway module, or drops the constant-time
// compare fails here.
//
// node:test, zero dependencies, no network.

import { ok, strictEqual, deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { handleChatCompletionsRequest } from "../src/gateway.js";
import { FakeTransport } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "../support/helpers.js";

// Distinctive synthetic secrets: `.invalid` (RFC 2606) so even a bug that
// treated them as locations could never resolve. Long enough to be
// unmistakable in any output they leaked into.
const OPERATOR_KEY = "op-7271-operator-secret-9f2c4e7a6b8d.invalid";
const WRONG_SAME_LENGTH = "x".repeat(OPERATOR_KEY.length);
const WRONG_SHORT = "short-key";

let sharedCandidates = null;
async function candidates() {
  sharedCandidates ??= (await loadConfiguredCandidates()).candidates;
  return sharedCandidates;
}

function body(overrides = {}) {
  return {
    model: "auto",
    messages: [{ role: "user", content: "Say hello." }],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    headers: { authorization: `Bearer ${OPERATOR_KEY}` },
    body: body(),
    gatewayKey: OPERATOR_KEY,
    eligibilityOptions: evaluationOptions,
    ...overrides,
  };
}

function serialized(result) {
  return JSON.stringify({ body: result.body, headers: result.headers ?? {} });
}

function assertKeyless(result, label) {
  const text = serialized(result);
  ok(!text.includes(OPERATOR_KEY), `${label} must not contain the operator key`);
  ok(!text.includes(WRONG_SAME_LENGTH), `${label} must not echo the presented wrong key`);
  ok(!text.includes(WRONG_SHORT), `${label} must not echo the presented short key`);
}

// Every error path the handler can return: each entry builds a request that
// exercises one branch. The sweep asserts key material is absent from all of
// them (401s, 500s, and every 400 validation branch).
async function errorPathRequests(all) {
  return [
    ["401 missing key", request({ candidates: all, headers: {} })],
    ["401 wrong key (same length)", request({ candidates: all, headers: { authorization: `Bearer ${WRONG_SAME_LENGTH}` } })],
    ["401 wrong key (short)", request({ candidates: all, headers: { authorization: `Bearer ${WRONG_SHORT}` } })],
    ["401 unprefixed bearer", request({ candidates: all, headers: { authorization: OPERATOR_KEY } })],
    ["401 empty bearer", request({ candidates: all, headers: { authorization: "Bearer " } })],
    ["401 non-string header", request({ candidates: all, headers: { authorization: 42 } })],
    ["500 missing expected key", request({ candidates: all, gatewayKey: "" })],
    ["500 non-string expected key", request({ candidates: all, gatewayKey: null })],
    ["500 non-object body", request({ candidates: all, body: [OPERATOR_KEY] })],
    ["400 missing model", request({ candidates: all, body: body({ model: undefined }) })],
    ["400 empty model", request({ candidates: all, body: body({ model: "  " }) })],
    ["400 empty messages", request({ candidates: all, body: body({ messages: [] }) })],
    ["400 bad message role", request({ candidates: all, body: body({ messages: [{ role: "tool", content: "x" }] }) })],
    ["400 unsupported modality", request({
      candidates: all,
      body: body({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this." },
            { type: "image_url", image_url: { url: "https://example.invalid/x.png" } },
          ],
        }],
      }),
    })],
    ["400 stream:true", request({ candidates: all, body: body({ stream: true }) })],
    ["400 bad stream type", request({ candidates: all, body: body({ stream: "yes" }) })],
    ["400 n>1", request({ candidates: all, body: body({ n: 2 }) })],
    ["400 logprobs", request({ candidates: all, body: body({ logprobs: true }) })],
    ["400 legacy functions", request({ candidates: all, body: body({ functions: [] }) })],
    ["400 bad tools", request({ candidates: all, body: body({ tools: {} }) })],
    ["400 tool_choice without tools", request({ candidates: all, body: body({ tool_choice: "auto" }) })],
    ["400 bad response_format", request({ candidates: all, body: body({ response_format: { type: "xml" } }) })],
    ["400 bad max_tokens", request({ candidates: all, body: body({ max_tokens: -1 }) })],
    ["400 empty candidate set", request({ candidates: [] })],
    ["400 pinned-ineligible", request({ candidates: all, body: body({ model: "orbit/retired-chat" }) })],
    ["400 unsatisfiable requirements", request({
      candidates: all,
      body: body({ response_format: { type: "json_object" }, max_tokens: 50 }),
    })],
    ["500 malformed candidates", request({ candidates: [null] })],
    ["500 network-claiming transport", request({
      candidates: all,
      transport: { async send() { return { networkUsed: true, output: { text: "live" } }; } },
    })],
    // Hostile transport whose thrown error embeds the operator key: the
    // handler must swallow it into a static 500, never propagate it.
    ["500 throwing transport", request({
      candidates: all,
      transport: { async send() { throw new Error(`upstream blew up: ${OPERATOR_KEY}`); } },
    })],
  ];
}

describe("operator-key handling audit (TOG-7271)", () => {
  it("no gateway error output contains key material on any error path", async () => {
    const all = await candidates();
    for (const [label, req] of await errorPathRequests(all)) {
      const result = await handleChatCompletionsRequest(req);
      assertKeyless(result, label);
    }
  });

  it("success outputs and transport records carry no key material", async () => {
    const all = await candidates();
    const transport = new FakeTransport();
    const result = await handleChatCompletionsRequest(
      request({ candidates: all, transport }),
    );
    strictEqual(result.httpStatus, 200);
    assertKeyless(result, "200 completion");
    for (const call of transport.calls) {
      const text = JSON.stringify(call);
      ok(!text.includes(OPERATOR_KEY), "transport call must not record the operator key");
    }
  });

  it("the handler logs nothing: no console output on success or error paths", async () => {
    const all = await candidates();
    const captured = [];
    const methods = ["log", "error", "warn", "debug", "info"];
    const originals = new Map(methods.map((m) => [m, console[m]]));
    for (const m of methods) {
      console[m] = (...args) => captured.push([m, ...args]);
    }
    try {
      await handleChatCompletionsRequest(request({ candidates: all, transport: new FakeTransport() }));
      for (const [, req] of await errorPathRequests(all)) {
        await handleChatCompletionsRequest(req);
      }
    } finally {
      for (const [m, fn] of originals) {
        console[m] = fn;
      }
    }
    strictEqual(captured.length, 0, "gateway handler must not write to console");
  });

  it("programmer-contract throws carry no key material", async () => {
    const all = await candidates();
    const throws = [
      () => handleChatCompletionsRequest(request({ candidates: "nope" })),
      () => handleChatCompletionsRequest(request({ candidates: all, eligibilityOptions: null })),
      () => handleChatCompletionsRequest(request({ candidates: all, transport: { send: "nope" } })),
    ];
    for (const fn of throws) {
      await fn().then(
        () => ok(false, "expected a TypeError"),
        (error) => {
          strictEqual(error instanceof TypeError, true);
          ok(!String(error.message).includes(OPERATOR_KEY), "throw must not contain the operator key");
        },
      );
    }
  });

  it("auth failures stay byte-identical across key lengths (no oracle)", async () => {
    const all = await candidates();
    const missing = await handleChatCompletionsRequest(
      request({ candidates: all, headers: {} }),
    );
    for (const presented of [
      WRONG_SAME_LENGTH,
      WRONG_SHORT,
      `${OPERATOR_KEY}-with-extra-suffix`,
    ]) {
      const result = await handleChatCompletionsRequest(
        request({ candidates: all, headers: { authorization: `Bearer ${presented}` } }),
      );
      deepStrictEqual(result, missing, "wrong keys of any length must match the missing-key 401");
      assertKeyless(result, "wrong-key 401");
    }
  });

  it("the timing-safe compare stays pinned in the gateway source", () => {
    const source = readFileSync(new URL("../src/gateway.js", import.meta.url), "utf8");
    ok(
      source.includes('timingSafeEqual') && /from "node:crypto"/.test(source),
      "gateway must compare keys with node:crypto timingSafeEqual",
    );
    ok(
      !/^[^/]*console\.(log|error|warn|debug|info)/m.test(source),
      "gateway module must contain no console logging sink",
    );
  });

  it("tracked snapshots carry no bearer material", () => {
    const root = new URL("..", import.meta.url);
    const snapshotFiles = ["snapshot-20260924T120000000Z-c6cdb62e.json", "snapshot-20260924T120500000Z-c6cdb62e.json"]
      .map((name) => `snapshots/${name}`);
    for (const rel of snapshotFiles) {
      const text = readFileSync(new URL(rel, root), "utf8");
      ok(!/bearer/i.test(text), `${rel} must not carry bearer material`);
      ok(!/authorization/i.test(text), `${rel} must not carry authorization material`);
    }
  });
});
