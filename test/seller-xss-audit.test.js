// Stored-XSS audit for TOG-7272: seller-controlled fields echoed by
// web/seller.js and web/listing-detail.js must render escaped on every echo
// path (node:test, zero dependencies, no network).
//
// Seller-controlled echo surface (src/sellerSubmission.js intake):
//   - entry.name      → confirm/receipt <h1>, <title>, stub entry.name →
//                       detail <h1>/<title>, shell noscript, fragment, index
//   - entry.description / provenance.etag → accepted but never rendered
//                       (no echo path; asserted by absence of raw output)
//   - provenance.source / fetchedAt → confirm/receipt provenance rows
//   - receipt timestamp → recorded-at row (server mints ISO; renderer takes
//                       any string, so a hostile value must still escape)
//   - providerId/modelId/entry.id → route-id allowlist (no <>"' pass
//                       validation) but renderers escape anyway; hostile ids
//                       are exercised direct (defense in depth).
// Evaluator-derived strings (reasons, verdict, supportState, operations,
// priceLabel) are escaped at every call site too; hostile ids prove the form
// actions and the shell's inline-fetch route stay encoded.

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import {
  confirmModel,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
  submissionToStubListing,
} from "../web/seller.js";
import {
  listingDetailFragment,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
  renderListingIndex,
  renderNotFound,
  renderRouteNotFound,
} from "../web/listing-detail.js";

const HOSTILES = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(2)>',
  "</script><script>alert(3)</script>",
  '\'"><svg onload=alert(4)>',
];

function assertEscaped(html, label) {
  for (const hostile of HOSTILES) {
    ok(!html.includes(hostile), `${label} renders raw ${JSON.stringify(hostile)}`);
  }
}

async function readSellerFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
}

// Hostile values that still pass the fail-closed intake validator:
// source keeps the synthetic:// prefix, etag fits the 256-char cap,
// description fits the 4k cap, name is a non-empty string.
function hostileSubmission(base) {
  const sub = structuredClone(base);
  sub.entry.name = HOSTILES[0];
  sub.entry.description = `desc ${HOSTILES[1]}`;
  sub.provenance.source = `synthetic://wayselect/${HOSTILES[2]}`;
  sub.provenance.etag = HOSTILES[3];
  return sub;
}

describe("seller stored-XSS audit (TOG-7272)", () => {
  it("escapes hostile seller fields on the confirm screen", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(hostileSubmission(fixtures.valid)));
    const html = renderSellerConfirm(model);
    assertEscaped(html, "confirm");
    // Escaped, not stripped: the entity form is present.
    ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "confirm escapes title");
    ok(html.includes("&lt;/script&gt;"), "confirm escapes provenance source");
  });

  it("escapes hostile seller fields on the receipt, including the timestamp", async () => {
    const fixtures = await readSellerFixtures();
    const model = confirmModel(validateSellerSubmission(hostileSubmission(fixtures.valid)));
    const html = renderSellerReceipt(model, HOSTILES[1]);
    assertEscaped(html, "receipt");
    ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "receipt escapes title");
    ok(
      html.includes("&quot;&gt;&lt;img src=x onerror=alert(2)&gt;"),
      "receipt escapes timestamp",
    );
  });

  it("escapes the seller-derived stub on every listing-detail echo path", async () => {
    const fixtures = await readSellerFixtures();
    const stub = submissionToStubListing(
      validateSellerSubmission(hostileSubmission(fixtures.valid)),
    );
    assertEscaped(renderListingDetail(stub), "detail");
    assertEscaped(renderListingDetailShell(stub), "shell");
    assertEscaped(listingDetailFragment(stub).html, "fragment");
    assertEscaped(renderListingIndex([stub]), "index");
    ok(
      renderListingDetail(stub).includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
      "detail escapes seller name",
    );
  });

  it("escapes hostile ids in form actions, index links, and the shell fetch", () => {
    const evilId = 'a"><script>alert(1)</script>';
    const evilModel = 'm</script><script>alert(2)</script>';
    // Direct hostile model (bypasses the route-id allowlist on purpose:
    // renderers must stay safe even for ids the validator would reject).
    const base = confirmModel(
      validateSellerSubmission({
        providerId: "northstar",
        modelId: "seller-chat",
        entry: {
          id: "seller-chat",
          name: "Seller Chat",
          description: "A synthetic seller-submitted chat listing.",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 8192, output: 2048 },
          cost: { input: 1, output: 2 },
          release_date: "2026-08",
          last_updated: "2026-09-20",
          open_weights: false,
        },
        provenance: {
          source: "synthetic://wayselect/seller-fixture-v1",
          fetchedAt: "2026-09-24T10:00:00.000Z",
        },
      }),
    );
    const hostileModel = {
      ...base,
      routeId: `${evilId}/${evilModel}`,
      providerId: evilId,
      modelId: evilModel,
      entryId: evilModel,
      title: HOSTILES[0],
    };
    const confirm = renderSellerConfirm(hostileModel);
    assertEscaped(confirm, "confirm hostile ids");
    ok(!confirm.includes("/sellers/submissions/a\""), "confirm action encodes quotes");
    ok(confirm.includes("%22%3E%3Cscript%3E"), "confirm action carries encoded id");

    const hostileListing = {
      schemaVersion: "v1",
      providerId: evilId,
      providerName: HOSTILES[1],
      modelId: evilModel,
      entry: {
        id: evilModel,
        name: HOSTILES[0],
        attachment: true,
        reasoning: false,
        tool_call: false,
        structured_output: false,
        modalities: { input: [HOSTILES[2]], output: ["text"] },
        cost: { input: 1, output: 1 },
      },
      provenance: {
        source: "synthetic://wayselect/seller-fixture-v1",
        fetchedAt: "2026-09-24T10:00:00.000Z",
      },
    };
    const detail = renderListingDetail(hostileListing);
    assertEscaped(detail, "detail hostile ids");
    ok(detail.includes("%3Cscript%3E"), "purchase action carries encoded id");
    const shell = renderListingDetailShell(hostileListing);
    assertEscaped(shell, "shell hostile ids");
    ok(!shell.includes("</script><script>"), "shell fetch route cannot break out");
    assertEscaped(renderListingIndex([hostileListing]), "index hostile ids");
  });

  it("escapes hostile values on the error and missing-intent pages", () => {
    assertEscaped(renderSellerIntentMissing(HOSTILES[0], HOSTILES[1]), "intent-missing");
    assertEscaped(
      renderSellerSubmissionError({
        code: HOSTILES[0],
        key: HOSTILES[1],
        source: HOSTILES[2],
        message: HOSTILES[3],
      }),
      "submission-error",
    );
    assertEscaped(renderListingDetailError(HOSTILES[0], HOSTILES[1]), "detail-error");
    assertEscaped(renderNotFound(HOSTILES[0], HOSTILES[1]), "not-found");
    assertEscaped(renderRouteNotFound(HOSTILES[2]), "route-not-found");
  });
});
