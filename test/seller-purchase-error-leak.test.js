// Seller/purchase error-message info-leak audit (TOG-6048).
//
// Gap S2 from the TOG-6013 gap-list doc: seller/purchase error paths must
// never leak internals (filesystem paths, stack traces, server-side IDs).
//
// Audit outcome (2026-09-27, main @ 24c1660): every `fail()` site in
// src/sellerSubmission.js and src/purchase.js builds its message from static
// copy plus caller-supplied key/source tokens only. No `process.cwd()`,
// `__dirname`, `error.stack`, fs errnos, or server-generated IDs appear in
// any validator message; no HTTP route surfaces validator messages (the
// purchase stub returns static `{error:"..."}` envelopes, and `.stack` is
// printed only by local operator scripts, never into responses). Zero
// distinct leaks found, so no redactions and no bug cards.
//
// This file pins that outcome: it triggers every seller/purchase error path
// (all 41 `fail()` regions across both validators, plus the purchase HTTP
// errors and the CLI failure formatter) and asserts no response carries a
// path, a stack frame, or an internal ID. node:test, zero dependencies.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import {
  PurchaseSubmissionError,
  SellerSubmissionError,
  formatCliFailure,
  validatePurchaseSubmission,
  validateSellerSubmission,
} from "../src/index.js";
import { createApp } from "../web/server.js";

// Far-future reference clock so fixture fetchedAt values (2026-09-24) are
// never "future" inside these tests regardless of the real wall clock.
const NOW = "2026-09-27T00:00:00.000Z";
const SELLER_SOURCE = "synthetic://wayselect/seller-fixture-v1";
const PURCHASE_SOURCE = "synthetic://wayselect/purchase-fixture-v1";

// Stack-trace markers. Kept narrow on purpose: validator copy legitimately
// contains substrings like "at most" and "must start with", so a bare
// /at\s/ or /stack/ match would false-positive.
const STACK_PATTERNS = [
  /\(\S+\.js:\d+:\d+\)/, // node frame location: " (file.js:line:col)"
  /^\s*at\s+\S+.*:\d+/m, // frame head: "    at fn (...:line)"
  /node:internal/, // node internals only ever appear in traces
  /stack trace/i, // literal trace header
];

// Filesystem-path / OS-error markers. Caller-supplied slug ids can never
// match these (route-id allowlist `[a-z0-9][a-z0-9-]{0,63}`), so any hit is
// a genuine server-path leak, not a caller echo.
const PATH_PATTERNS = [
  /\.js:\d+/, // file:line reference
  /node_modules/, // dependency path
  /\/paperclip\//, // workspace path
  /\b[A-Za-z]:\\/, // windows absolute path
  /\bENOENT\b|\bENOTDIR\b|\bEACCES\b|\bEBADF\b/, // fs errnos
  /\/home\/|\/root\/|\/var\/|\/usr\/lib\/|\/private\//, // host dirs
];

// Server-generated IDs. Fixtures and validator copy contain no UUIDs and no
// pid/fd/inode tokens, so any hit is a genuine internal-ID leak.
const ID_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // uuid
  /\bpid\b|\binode\b|\bfd=\d+/, // process/fd tokens
];

function assertNoLeak(message, label) {
  for (const pattern of [...STACK_PATTERNS, ...PATH_PATTERNS, ...ID_PATTERNS]) {
    ok(!pattern.test(message), `${label}: leak pattern ${pattern} hit in: ${message}`);
  }
  ok(!message.includes(process.cwd()), `${label}: repo absolute path in: ${message}`);
}

function assertEnvelope(error, ExpectedClass, label) {
  ok(error instanceof ExpectedClass, `${label}: wrong class: ${error}`);
  ok(typeof error.code === "string" && error.code !== "", `${label}: missing code`);
  ok(!("stack" in error) || typeof error.stack === "string", `${label}: odd stack`);
  // The message carries only the envelope: "[source ...] static detail".
  // error.stack exists (all Errors have one) but must never be embedded.
  const stackFrame = (error.stack ?? "").split("\n").slice(1).join("\n");
  ok(
    stackFrame === "" || !error.message.includes(stackFrame.trim().split("\n")[0] ?? "###"),
    `${label}: stack frame embedded in message`,
  );
}

async function readFixtures(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
}

// Each entry: [label, mutate(clone)]. mutate must make validation fail.
function sellerCases() {
  const overlongSlug = "a".repeat(65);
  const traversal = "../../etc/passwd";
  return [
    ["non-object null", () => null],
    ["missing provenance", (s) => void delete s.provenance],
    ["non-object provenance", (s) => void (s.provenance = "synthetic://x")],
    ["missing provenance.source", (s) => void delete s.provenance.source],
    ["non-synthetic provenance.source", (s) => void (s.provenance.source = "https://evil.invalid/x")],
    ["bad fetchedAt", (s) => void (s.provenance.fetchedAt = "not-a-timestamp")],
    ["future fetchedAt", (s) => void (s.provenance.fetchedAt = "3026-01-01T00:00:00.000Z")],
    ["overlong etag", (s) => void (s.provenance.etag = "e".repeat(257))],
    ["top-level unknown field", (s) => void (s.family = "x")],
    ["entry unknown field", (s) => void (s.entry.family = "x")],
    ["modalities unknown subkey", (s) => void (s.entry.modalities.audio = ["text"])],
    ["limit unknown subkey", (s) => void (s.entry.limit.minimum = 1)],
    ["cost unknown subkey", (s) => void (s.entry.cost.currency = "usd")],
    ["provenance unknown field", (s) => void (s.provenance.hash = "sha256:x")],
    ["forbidden url top-level", (s) => void (s.url = "https://example.invalid/x")],
    ["forbidden endpoint nested", (s) => void (s.entry.endpoint = "https://example.invalid/x")],
    ["forbidden baseUrl deep", (s) => void (s.entry.modalities.baseUrl = "https://example.invalid/x")],
    ["forbidden apiUrl in provenance", (s) => void (s.provenance.apiUrl = "https://example.invalid/x")],
    ["missing providerId", (s) => void delete s.providerId],
    ["blank providerId", (s) => void (s.providerId = "   ")],
    ["overlong providerId", (s) => void (s.providerId = overlongSlug)],
    ["traversal providerId", (s) => void (s.providerId = traversal)],
    ["uppercase modelId", (s) => void (s.modelId = "Seller-Chat")],
    // id-mismatch echoes both submitted slugs (allowlisted, caller bytes).
    ["modelId/entry.id mismatch", (s) => void (s.modelId = "other-id")],
    ["missing entry", (s) => void delete s.entry],
    ["non-slug entry.id", (s) => void (s.entry.id = "Has/Caps")],
    ["blank entry.name", (s) => void (s.entry.name = "")],
    ["overlong description", (s) => void (s.entry.description = "d".repeat(4001))],
    ["mistyped attachment", (s) => void (s.entry.attachment = "yes")],
    ["mistyped temperature", (s) => void (s.entry.temperature = 1)],
    ["empty modalities.input", (s) => void (s.entry.modalities.input = [])],
    ["bad modality value", (s) => void (s.entry.modalities.output = ["telepathy"])],
    ["modalities missing output", (s) => void delete s.entry.modalities.output],
    ["negative limit.context", (s) => void (s.entry.limit.context = -1)],
    ["fractional limit.output", (s) => void (s.entry.limit.output = 1.5)],
    ["limit missing context", (s) => void delete s.entry.limit.context],
    ["negative cost.input", (s) => void (s.entry.cost.input = -0.5)],
    ["partial cost", (s) => void delete s.entry.cost.output],
    ["bad release_date format", (s) => void (s.entry.release_date = "09/2026")],
    ["impossible last_updated", (s) => void (s.entry.last_updated = "2026-02-30")],
    ["bad status", (s) => void (s.entry.status = "live")],
  ];
}

function purchaseCases() {
  const overlongSlug = "a".repeat(65);
  return [
    ["non-object null", () => null],
    ["missing provenance", (s) => void delete s.provenance],
    ["non-object provenance", (s) => void (s.provenance = "synthetic://x")],
    ["missing provenance.source", (s) => void delete s.provenance.source],
    ["non-synthetic provenance.source", (s) => void (s.provenance.source = "https://evil.invalid/x")],
    ["bad fetchedAt", (s) => void (s.provenance.fetchedAt = "not-a-timestamp")],
    ["future fetchedAt", (s) => void (s.provenance.fetchedAt = "3026-01-01T00:00:00.000Z")],
    ["overlong etag", (s) => void (s.provenance.etag = "e".repeat(257))],
    ["missing providerId", (s) => void delete s.providerId],
    ["blank modelId", (s) => void (s.modelId = "  ")],
    ["overlong modelId", (s) => void (s.modelId = overlongSlug)],
    ["traversal modelId", (s) => void (s.modelId = "../x")],
    ["missing buyerId", (s) => void delete s.buyerId],
    ["blank buyerId", (s) => void (s.buyerId = "")],
    ["overlong buyerId", (s) => void (s.buyerId = "b".repeat(121))],
    ["missing confirm", (s) => void delete s.confirm],
    ["mistyped confirm", (s) => void (s.confirm = "yes")],
    ["false confirm", (s) => void (s.confirm = false)],
    ["top-level unknown field", (s) => void (s.quantity = 2)],
    ["provenance unknown field", (s) => void (s.provenance.hash = "sha256:x")],
    ["forbidden url top-level", (s) => void (s.url = "https://example.invalid/x")],
    ["forbidden endpoint in provenance", (s) => void (s.provenance.endpoint = "https://example.invalid/x")],
  ];
}

describe("seller/purchase error-message info-leak audit (TOG-6048)", () => {
  it("every seller rejection is leak-free single-line copy + caller tokens", async () => {
    const fixtures = await readFixtures("seller-submission.synthetic.json");
    let covered = 0;
    for (const [label, mutate] of sellerCases()) {
      // A case either mutates the valid clone in place (returns undefined)
      // or returns a replacement submission outright (e.g. null).
      const submission = structuredClone(fixtures.valid);
      const replacement = mutate(submission);
      const input = replacement === undefined ? submission : replacement;
      let error = null;
      try {
        validateSellerSubmission(input, { now: NOW });
      } catch (caught) {
        error = caught;
      }
      ok(error !== null, `seller case passed validation, expected rejection: ${label}`);
      assertEnvelope(error, SellerSubmissionError, `seller/${label}`);
      assertNoLeak(error.message, `seller/${label}`);
      ok(!error.message.includes("\n"), `seller/${label}: multiline message`);
      covered += 1;
    }
    // Guard against the table silently shrinking below the fail() regions.
    ok(covered >= 40, `seller coverage regressed: only ${covered} cases`);
  });

  it("every purchase rejection is leak-free single-line copy + caller tokens", async () => {
    const fixtures = await readFixtures("purchase.synthetic.json");
    let covered = 0;
    for (const [label, mutate] of purchaseCases()) {
      const submission = structuredClone(fixtures.valid);
      const replacement = mutate(submission);
      const input = replacement === undefined ? submission : replacement;
      let error = null;
      try {
        validatePurchaseSubmission(input, { now: NOW });
      } catch (caught) {
        error = caught;
      }
      ok(error !== null, `purchase case passed validation, expected rejection: ${label}`);
      assertEnvelope(error, PurchaseSubmissionError, `purchase/${label}`);
      assertNoLeak(error.message, `purchase/${label}`);
      ok(!error.message.includes("\n"), `purchase/${label}: multiline message`);
      covered += 1;
    }
    ok(covered >= 20, `purchase coverage regressed: only ${covered} cases`);
  });

  it("invalid options.now fails closed without leaking", async () => {
    const sellerFixtures = await readFixtures("seller-submission.synthetic.json");
    const purchaseFixtures = await readFixtures("purchase.synthetic.json");
    for (const [label, run] of [
      ["seller", () => validateSellerSubmission(structuredClone(sellerFixtures.valid), { now: "not-a-date" })],
      ["purchase", () => validatePurchaseSubmission(structuredClone(purchaseFixtures.valid), { now: "not-a-date" })],
    ]) {
      let error = null;
      try {
        run();
      } catch (caught) {
        error = caught;
      }
      ok(error !== null, `${label}: invalid now passed validation`);
      assertNoLeak(error.message, `${label}/invalid-now`);
    }
  });

  it("exotic caller bytes in provenance.source stay caller-only (no server leak)", async () => {
    const fixtures = await readFixtures("seller-submission.synthetic.json");
    // Synthetic-prefixed so it passes the prefix gate, then a later failure
    // (missing entry) embeds it via the source tag. The message reflects
    // caller bytes verbatim but must gain no server internals thereby.
    const submission = structuredClone(fixtures.valid);
    submission.provenance.source = "synthetic://wayselect/<script>alert(1)</script>";
    delete submission.entry;
    let error = null;
    try {
      validateSellerSubmission(submission, { now: NOW });
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof SellerSubmissionError, `expected rejection, got ${error}`);
    strictEqual(error.source, "synthetic://wayselect/<script>alert(1)</script>");
    ok(error.message.includes(error.source), "rejection must name the source");
    assertNoLeak(error.message, "seller/exotic-source");
  });

  it("CLI failure rendering adds no stack or paths to seller/purchase errors", async () => {
    const fixtures = await readFixtures("seller-submission.synthetic.json");
    const bad = structuredClone(fixtures.valid);
    delete bad.provenance;
    let error = null;
    try {
      validateSellerSubmission(bad, { now: NOW });
    } catch (caught) {
      error = caught;
    }
    const rendered = formatCliFailure(error);
    strictEqual(rendered, `${error.name}: ${error.message}\n`);
    assertNoLeak(rendered, "cli/seller-error");
  });
});

describe("purchase HTTP error responses carry no internals (TOG-6048)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postPurchase(base, path) {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  }

  it("unknown listing, known listing, and wrong method are static envelopes", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });

    const unknown = await postPurchase(base, "/listings/northstar/nope/purchase");
    strictEqual(unknown.status, 404);
    strictEqual(unknown.json.error, "listing_not_found");
    assertNoLeak(unknown.text, "http/purchase-unknown");

    const known = await postPurchase(base, "/listings/northstar/alpha-chat/purchase");
    strictEqual(known.status, 403);
    strictEqual(known.json.error, "preview_only");
    strictEqual(known.json.message, "Purchases are disabled in preview. No backend writes.");
    assertNoLeak(known.text, "http/purchase-known");

    const wrongMethod = await fetch(`${base}/listings/northstar/alpha-chat/purchase`);
    const wrongText = await wrongMethod.text();
    strictEqual(wrongMethod.status, 405);
    strictEqual(JSON.parse(wrongText).error, "method_not_allowed");
    assertNoLeak(wrongText, "http/purchase-method");
  });

  it("undecodable purchase path segments 404 without leaking", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const bad = await postPurchase(base, "/listings/%E0%A4%A/alpha-chat/purchase");
    strictEqual(bad.status, 404);
    strictEqual(bad.json.error, "listing_not_found");
    assertNoLeak(bad.text, "http/purchase-bad-encoding");
  });

  it("JSON listing miss carries no internals", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/nope`, {
      headers: { accept: "application/json" },
    });
    const text = await res.text();
    strictEqual(res.status, 404);
    strictEqual(JSON.parse(text).error, "listing_not_found");
    assertNoLeak(text, "http/listing-json-miss");
  });
});
