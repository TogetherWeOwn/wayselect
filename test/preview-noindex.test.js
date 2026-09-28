// TOG-6368 (Gap G7): noindex on preview pages.
//
// Staging deploys serve stub listings over real hostnames, and no render
// carried a robots signal — indexed stubs would poison search results.
// Pinned behavior (defense in depth, both layers or the page is indexable):
//
//   - every HTML page carries `<meta name="robots" content="noindex,
//     nofollow">` (covers crawlers that parse HTML);
//   - every HTML *response* carries `X-Robots-Tag: noindex, nofollow`
//     (covers crawlers that honor headers without parsing the body).
//   - JSON responses (fragments, errors, purchase stub) carry no robots
//     header — there is no page to index.
//
// node:test, zero dependencies, stub fixtures only.

import { ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { validateSellerSubmission } from "../src/sellerSubmission.js";
import { getStubListing } from "../web/stub-listing.js";
import {
  renderInvalidFilter,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
  renderRouteNotFound,
} from "../web/listing-detail.js";
import {
  confirmModel,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
} from "../web/seller.js";
import { createApp } from "../web/server.js";

const ROBOTS_META = '<meta name="robots" content="noindex, nofollow">';
const NOINDEX = "noindex, nofollow";

async function sellerModel() {
  const fixtures = JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
  return confirmModel(validateSellerSubmission(structuredClone(fixtures.valid)));
}

describe("preview noindex meta tag (TOG-6368)", () => {
  it("listing pages carry the robots meta tag", () => {
    const listing = getStubListing("northstar", "alpha-chat");
    ok(renderListingIndex([], undefined, undefined).includes(ROBOTS_META), "index");
    ok(renderListingDetailShell(listing).includes(ROBOTS_META), "detail shell");
    ok(renderListingDetail(listing).includes(ROBOTS_META), "legacy full detail");
    ok(
      renderInvalidFilter({ kind: "capability", value: "bogus", valid: ["reasoning"] }).includes(
        ROBOTS_META,
      ),
      "invalid-filter 400",
    );
    ok(renderListingDetailError("northstar", "alpha-chat").includes(ROBOTS_META), "500 error");
    ok(renderNotFound("northstar", "nope").includes(ROBOTS_META), "unknown listing 404");
    ok(renderRouteNotFound("/nope").includes(ROBOTS_META), "unknown path 404");
    ok(renderPreviewDisabled().includes(ROBOTS_META), "preview-disabled 404");
  });

  it("seller pages carry the robots meta tag", async () => {
    const model = await sellerModel();
    ok(renderSellerConfirm(model).includes(ROBOTS_META), "confirm");
    ok(
      renderSellerReceipt(model, new Date().toISOString()).includes(ROBOTS_META),
      "receipt",
    );
    ok(
      renderSellerIntentMissing("northstar", "seller-chat").includes(ROBOTS_META),
      "intent-missing",
    );
    ok(
      renderSellerSubmissionError({
        code: "unknown-field",
        key: "endpoint",
        source: "synthetic://wayselect/seller-fixture-v1",
      }).includes(ROBOTS_META),
      "submission-error",
    );
  });
});

describe("preview X-Robots-Tag header (TOG-6368)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("HTML responses carry X-Robots-Tag and the meta tag", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const pages = [
      ["/listings", 200],
      ["/listings/northstar/alpha-chat", 200],
      ["/listings?capability=bogus", 400],
      ["/listings/northstar/nope", 404],
    ];
    for (const [path, status] of pages) {
      const res = await fetch(`${base}${path}`);
      strictEqual(res.status, status, `GET ${path}`);
      strictEqual(res.headers.get("x-robots-tag"), NOINDEX, `GET ${path} header`);
      ok((await res.text()).includes(ROBOTS_META), `GET ${path} meta`);
    }
    // TOG-5714 browser fallback: explicit text/html on an unknown path is
    // also an HTML page crawlers could index.
    const fallback = await fetch(`${base}/nope`, { headers: { accept: "text/html" } });
    strictEqual(fallback.status, 404);
    strictEqual(fallback.headers.get("x-robots-tag"), NOINDEX, "fallback header");
    ok((await fallback.text()).includes(ROBOTS_META), "fallback meta");
  });

  it("flag-off pages stay noindexed", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "0" });
    for (const path of ["/listings", "/listings/northstar/alpha-chat"]) {
      const res = await fetch(`${base}${path}`);
      strictEqual(res.status, 404, `GET ${path}`);
      strictEqual(res.headers.get("x-robots-tag"), NOINDEX, `GET ${path} header`);
      ok((await res.text()).includes(ROBOTS_META), `GET ${path} meta`);
    }
  });

  it("seller confirm screen served over HTTP carries both signals", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = JSON.parse(
      await readFile(
        new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
        "utf8",
      ),
    );
    const accepted = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    strictEqual(accepted.status, 200);
    // TOG-6708: the confirm route serves JSON by default — no page to
    // index, so no robots header — and HTML only on explicit `text/html`.
    const confirmJson = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
    );
    strictEqual(confirmJson.status, 200);
    strictEqual(confirmJson.headers.get("x-robots-tag"), null, "confirm JSON header");
    await confirmJson.text();
    const confirm = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { headers: { accept: "text/html" } },
    );
    strictEqual(confirm.status, 200);
    strictEqual(confirm.headers.get("x-robots-tag"), NOINDEX, "confirm header");
    ok((await confirm.text()).includes(ROBOTS_META), "confirm meta");
  });

  it("JSON responses carry no robots header", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // JSON fragment behind the detail shell.
    const fragment = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    strictEqual(fragment.status, 200);
    strictEqual(fragment.headers.get("x-robots-tag"), null, "fragment header");
    // Unknown-path JSON 404 (fetch/curl default Accept).
    const unknown = await fetch(`${base}/nope`);
    strictEqual(unknown.status, 404);
    strictEqual(unknown.headers.get("x-robots-tag"), null, "JSON 404 header");
    // Purchase stub refusal.
    const purchase = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
      method: "POST",
    });
    strictEqual(purchase.status, 403);
    strictEqual(purchase.headers.get("x-robots-tag"), null, "purchase header");
  });
});
