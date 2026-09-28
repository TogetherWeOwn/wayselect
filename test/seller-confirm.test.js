// Tests for the TOG-4969 seller listing-creation slice: submission intake,
// fail-closed validation display, confirm screen, and listing-created
// receipt (spec: TOG-4958 §3 steps 5–6; node:test, zero dependencies).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import { createApp } from "../web/server.js";
import {
  confirmModel,
  confirmModelJson,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
  submissionToStubListing,
} from "../web/seller.js";

async function readSellerFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
}

describe("seller confirm model (TOG-4969)", () => {
  it("restates route, price, support, and the exact verdict codes", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));

    strictEqual(model.routeId, "northstar/seller-chat");
    strictEqual(model.title, "Seller Chat");
    strictEqual(model.priceLabel, "in=1 out=2");
    deepStrictEqual(model.price, { input: 1, output: 2 });
    // Normalized capabilities mirror the submitted flags.
    strictEqual(model.capabilities.toolUse, true);
    strictEqual(model.capabilities.attachment, false);
    // Derived operations come from modalities (text-in/text-out → chat).
    deepStrictEqual(model.operations, ["chat"]);
    // New listings enter as catalogued only (SD7) with no evidence.
    strictEqual(model.supportState, "catalogued");
    deepStrictEqual(model.configuredOperations, []);
    ok(model.evidenceAge.includes("missing-evidence"));
    // Fail-closed verdict carries the exact evaluator reason codes.
    strictEqual(model.eligible, false);
    ok(model.reasons.includes("support-state:catalogued"));
    strictEqual(model.verdict, "Blocked");
    strictEqual(model.provenance.source, "synthetic://wayselect/seller-fixture-v1");
    ok(Object.isFrozen(model));
    ok(Object.isFrozen(model.reasons));
  });

  it("renders unpublished price as Price unpublished, never an invented number", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(structuredClone(fixtures.minimal)));

    strictEqual(model.price, null);
    strictEqual(model.priceLabel, "Price unpublished");
    const html = renderSellerConfirm(model);
    ok(html.includes("Price unpublished"));
    const json = confirmModelJson(model);
    strictEqual(json.price, null);
    strictEqual(json.priceLabel, "Price unpublished");
  });

  it("adapts submissions to the stub-listing shape for the shared pipeline", async () => {
    const fixtures = await readSellerFixtures();
    const stub = submissionToStubListing(
      validateSellerSubmission(structuredClone(fixtures.valid)),
    );
    strictEqual(stub.providerId, "northstar");
    strictEqual(stub.modelId, "seller-chat");
    strictEqual(stub.entry.name, "Seller Chat");
    strictEqual(stub.entry.tool_call, true);
  });
});

describe("seller confirm renderer (TOG-4969)", () => {
  it("restates every §3-step-5 fact with reason codes verbatim in <code>", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));
    const html = renderSellerConfirm(model);

    ok(html.includes("<h1>Confirm listing: Seller Chat</h1>"));
    ok(html.includes("<code>northstar/seller-chat</code>"));
    ok(html.includes("in=1 out=2"));
    ok(html.includes("<code>catalogued</code>"));
    ok(html.includes("no evidence recorded"));
    ok(html.includes("<code>support-state:catalogued</code>"));
    ok(html.includes("records intent only"));
    ok(html.includes("synthetic://wayselect/seller-fixture-v1"));
  });

  it("escapes untrusted submission values", async () => {
    const fixtures = await readSellerFixtures();
    const submission = structuredClone(fixtures.valid);
    submission.entry.name = "<b>evil</b>";
    const model = confirmModel(validateSellerSubmission(submission));
    const html = renderSellerConfirm(model);
    ok(!html.includes("<b>evil</b>"));
    ok(html.includes("&lt;b&gt;evil&lt;/b&gt;"));
  });

  it("receipt shows intent recorded, price, provenance, and the dry-run disclaimer", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));
    const html = renderSellerReceipt(model, "2026-09-27T10:00:00.000Z");

    ok(html.includes("intent"));
    ok(html.includes("in=1 out=2"));
    ok(html.includes("<code>catalogued</code>"));
    ok(html.includes("<code>2026-09-27T10:00:00.000Z</code>"));
    ok(html.includes("synthetic://wayselect/seller-fixture-v1"));
    ok(html.includes("No listing was published"));
  });

  it("rejection display names the offending key + provenance source", async () => {
    const html = renderSellerSubmissionError({
      code: "forbidden-field",
      key: "submission.entry.url",
      source: "synthetic://wayselect/seller-fixture-v1",
      message: "[source synthetic://wayselect/seller-fixture-v1] nope",
    });
    ok(html.includes("<code>forbidden-field</code>"));
    ok(html.includes("<code>submission.entry.url</code>"));
    ok(html.includes("<code>synthetic://wayselect/seller-fixture-v1</code>"));
    ok(html.includes('role="alert"'));
  });

  it("missing-intent page never guesses a confirm screen", () => {
    const html = renderSellerIntentMissing("northstar", "nope");
    ok(html.includes("No pending seller intent"));
    ok(html.includes("<code>northstar/nope</code>"));
  });
});

describe("seller intake + confirm routes (TOG-4969)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postSubmission(base, body, extraHeaders = {}) {
    const res = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it("intakes a valid submission and serves its confirm screen + receipt", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readSellerFixtures();
    const accepted = await postSubmission(base, fixtures.valid);
    strictEqual(accepted.status, 200);
    strictEqual(accepted.json.routeId, "northstar/seller-chat");
    strictEqual(accepted.json.verdict, "Blocked");
    ok(accepted.json.reasons.includes("support-state:catalogued"));
    ok(accepted.json.confirmPath.endsWith("/sellers/submissions/northstar/seller-chat/confirm"));

    const confirm = await fetch(`${base}/sellers/submissions/northstar/seller-chat/confirm`);
    strictEqual(confirm.status, 200);
    const confirmJson = await confirm.json();
    strictEqual(confirmJson.routeId, "northstar/seller-chat");

    const confirmHtml = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { headers: { accept: "text/html" } },
    );
    strictEqual(confirmHtml.status, 200);
    const confirmText = await confirmHtml.text();
    ok(confirmText.includes("Confirm listing: Seller Chat"));
    ok(confirmText.includes("<code>support-state:catalogued</code>"));

    const receipt = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { method: "POST" },
    );
    strictEqual(receipt.status, 200);
    const receiptJson = await receipt.json();
    strictEqual(receiptJson.recorded, true);
    strictEqual(receiptJson.intentOnly, true);
    ok(typeof receiptJson.recordedAt === "string");
    strictEqual(receiptJson.routeId, "northstar/seller-chat");
  });

  it("rejects forbidden location fields, unknown fields, and missing provenance fail-closed", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readSellerFixtures();

    const forbidden = structuredClone(fixtures.valid);
    forbidden.entry.url = "https://example.invalid/x";
    const rForbidden = await postSubmission(base, forbidden);
    strictEqual(rForbidden.status, 400);
    strictEqual(rForbidden.json.code, "forbidden-field");
    strictEqual(rForbidden.json.key, "submission.entry.url");
    strictEqual(rForbidden.json.source, "synthetic://wayselect/seller-fixture-v1");

    const unknown = structuredClone(fixtures.valid);
    unknown.extra = true;
    const rUnknown = await postSubmission(base, unknown);
    strictEqual(rUnknown.status, 400);
    strictEqual(rUnknown.json.code, "unknown-field");
    strictEqual(rUnknown.json.key, "submission.extra");

    const noProvenance = structuredClone(fixtures.valid);
    delete noProvenance.provenance;
    const rNoProvenance = await postSubmission(base, noProvenance);
    strictEqual(rNoProvenance.status, 400);
    strictEqual(rNoProvenance.json.code, "missing-provenance");
    strictEqual(rNoProvenance.json.key, "provenance");

    // Browser callers get the named rejection page, not JSON.
    const rHtml = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/html" },
      body: JSON.stringify(forbidden),
    });
    strictEqual(rHtml.status, 400);
    const html = await rHtml.text();
    ok(html.includes("Submission rejected"));
    ok(html.includes("<code>submission.entry.url</code>"));
  });

  it("404s unknown intents and refuses wrong methods", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const missing = await fetch(`${base}/sellers/submissions/northstar/nope/confirm`);
    strictEqual(missing.status, 404);
    deepStrictEqual(await missing.json(), {
      error: "no_pending_intent",
      routeId: "northstar/nope",
    });
    const intakeGet = await fetch(`${base}/sellers/submissions`);
    strictEqual(intakeGet.status, 405);
    const confirmPut = await fetch(`${base}/sellers/submissions/northstar/nope/confirm`, {
      method: "PUT",
    });
    strictEqual(confirmPut.status, 405);
  });

  it("maps body-gate failures to 400/413 before any validation runs", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const wrongType = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x=1",
    });
    strictEqual(wrongType.status, 400);
    const malformed = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    strictEqual(malformed.status, 400);
  });

  it("gates every seller route behind the preview flag", async () => {
    const base = await start({});
    const fixtures = await readSellerFixtures();
    const posted = await postSubmission(base, fixtures.valid);
    strictEqual(posted.status, 404);
    strictEqual(posted.json.error, "preview_disabled");
    const confirmed = await fetch(`${base}/sellers/submissions/northstar/seller-chat/confirm`);
    strictEqual(confirmed.status, 404);
  });

  it("receipt carries no payment, payout, or location fields", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readSellerFixtures();
    await postSubmission(base, fixtures.valid);
    const receipt = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { method: "POST" },
    );
    const body = JSON.stringify(await receipt.json());
    for (const field of ["amount", "charge", "paymentUrl", "payout", "url", "endpoint", "baseUrl", "apiUrl"]) {
      ok(!body.includes(`"${field}"`), `receipt must not carry ${field}`);
    }
  });
});
