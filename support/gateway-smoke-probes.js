// Gateway probes for the staging smoke (TOG-7278).
//
// The Phase-1 gateway (src/gateway.js) has no HTTP binding yet, so these
// probes drive the handler in-process: synthetic fixture candidates, the
// FakeTransport, and a throwaway key minted per run (never a credential).
// They pin the two contracts the smoke must fail loud on:
//   G1  401 — missing and wrong keys return the exact authentication_error
//       envelope with `WWW-Authenticate: Bearer`, byte-identical to each
//       other, and never reach the transport.
//   G2  auto-route dry run — `model: "auto"` with the right key returns a
//       200 ChatCompletion from an eligible route, labeled dryRun +
//       synthetic, through exactly one fake-transport call with
//       networkUsed:false.
//
// `handle` is injectable so tests can prove a regressed handler fails the
// probes; the smoke always passes the real handler.

import { randomBytes } from "node:crypto";
import { FakeTransport, handleChatCompletionsRequest } from "../src/index.js";
import { evaluationOptions, loadConfiguredCandidates } from "./helpers.js";

const EXPECTED_401_BODY = JSON.stringify({
  error: {
    message: "Invalid or missing gateway credentials.",
    type: "authentication_error",
    code: "invalid_api_key",
  },
});

function describe(result) {
  return `http=${result?.httpStatus} body=${JSON.stringify(result?.body ?? null).slice(0, 200)}`;
}

export async function runGatewayProbes({ handle = handleChatCompletionsRequest } = {}) {
  const { candidates } = await loadConfiguredCandidates();
  const gatewayKey = `smoke-${randomBytes(16).toString("hex")}`;
  const eligibilityOptions = {
    now: evaluationOptions.now,
    maxEvidenceAgeMs: evaluationOptions.maxEvidenceAgeMs,
    skipCatalogCheck: evaluationOptions.skipCatalogCheck,
  };
  const call = (headers, transport) =>
    handle({
      headers,
      body: { model: "auto", messages: [{ role: "user", content: "Smoke probe." }] },
      gatewayKey,
      candidates,
      eligibilityOptions,
      transport,
    });
  const probes = [];
  const probe = (id, label, ok, detail) => probes.push({ id, label, ok: Boolean(ok), detail });

  // ---- G1: 401 on missing and wrong keys ----
  const missingTransport = new FakeTransport();
  const missing = await call({}, missingTransport);
  probe(
    "G1",
    "gateway: missing key returns exact 401 body + WWW-Authenticate: Bearer",
    missing?.httpStatus === 401 &&
      JSON.stringify(missing.body) === EXPECTED_401_BODY &&
      missing.headers?.["WWW-Authenticate"] === "Bearer",
    describe(missing),
  );
  const wrongTransport = new FakeTransport();
  const wrong = await call({ authorization: `Bearer ${gatewayKey}-wrong` }, wrongTransport);
  probe(
    "G1b",
    "gateway: wrong key returns 401 byte-identical to missing key",
    wrong?.httpStatus === 401 && JSON.stringify(wrong) === JSON.stringify(missing),
    describe(wrong),
  );
  probe(
    "G1c",
    "gateway: 401 paths never reach the transport",
    missingTransport.calls.length === 0 && wrongTransport.calls.length === 0,
    `transport calls missing=${missingTransport.calls.length} wrong=${wrongTransport.calls.length}`,
  );

  // ---- G2: auto-route dry run ----
  const transport = new FakeTransport();
  const routed = await call({ authorization: `Bearer ${gatewayKey}` }, transport);
  const routeIds = new Set(candidates.map((candidate) => candidate.routeId));
  probe(
    "G2",
    "gateway: auto-route returns a 200 ChatCompletion from a catalog route",
    routed?.httpStatus === 200 &&
      routed.body?.object === "chat.completion" &&
      routeIds.has(routed.body?.model),
    describe(routed),
  );
  probe(
    "G2b",
    "gateway: auto-route response is labeled dryRun + synthetic",
    routed?.body?.wayselect?.dryRun === true &&
      routed.body.wayselect.synthetic === true &&
      /Synthetic response from/.test(routed.body.choices?.[0]?.message?.content ?? ""),
    JSON.stringify(routed?.body?.wayselect ?? null),
  );
  probe(
    "G2c",
    "gateway: auto-route makes exactly one fake-transport call (networkUsed:false)",
    transport.calls.length === 1 && transport.calls[0]?.routeId === routed?.body?.model,
    `transport calls=${JSON.stringify(transport.calls.map((c) => c.routeId))}`,
  );
  return probes;
}
