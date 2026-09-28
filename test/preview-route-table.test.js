// Route-table coverage for the preview server OpenAPI doc (TOG-6040, gap G3).
//
// The deliverable is docs/preview-server.openapi.json: the machine-readable
// route table for web/server.js. This test pins the acceptance criterion —
// every route in web/server.js is represented in the artifact — two ways:
//   1. Static: each route shape the server source defines appears in the doc,
//      with the query vocabulary (incl. `sort`, TOG-6362), the triage
//      envelope (`x-request-id`/`requestId`, TOG-6717), and the exact-match
//      (case-sensitive, TOG-6711) contract reflected.
//   2. Live: each documented path answers on a real server with the
//      documented success status, and documented error envelopes carry the
//      triage id with header/body agreement.
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const SPEC_PATH = new URL("../docs/preview-server.openapi.json", import.meta.url);
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

function readSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, "utf8"));
}

describe("preview route table (TOG-6040)", () => {
  it("is valid JSON with the expected path inventory", () => {
    const spec = readSpec();
    strictEqual(spec.openapi, "3.1.0");
    deepStrictEqual(Object.keys(spec.paths).sort(), [
      "/favicon.ico",
      "/healthz",
      "/listings",
      "/listings/{provider}/{model}",
      "/listings/{provider}/{model}/purchase",
      "/sellers/submissions",
      "/sellers/submissions/{provider}/{model}/confirm",
    ]);
  });

  it("is linked from the README docs index", async () => {
    // Discoverability is the point of gap G3: the artifact must be
    // reachable from the README docs index, not just the docs/ folder.
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    ok(
      readme.includes("docs/preview-server.openapi.json"),
      "README.md docs index must link docs/preview-server.openapi.json",
    );
  });

  it("info.version pins the package manifest version", () => {
    const spec = readSpec();
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    strictEqual(spec.info.version, manifest.version);
  });

  it("represents every route shape defined in web/server.js", () => {
    const source = readFileSync(new URL("../web/server.js", import.meta.url), "utf8");
    // Route shapes the server dispatches on: two exact paths plus the
    // regex-backed templates. If a new route lands in server.js without a
    // doc entry, add its marker here and to the OpenAPI paths.
    const expectedMarkers = [
      "/healthz",
      "/favicon.ico",
      "/listings",
      "/sellers/submissions",
      "purchase",
      "confirm",
    ];
    for (const marker of expectedMarkers) {
      ok(source.includes(marker), `server.js must still define ${marker}`);
    }
    const doc = JSON.stringify(readSpec());
    const docMarkers = [
      "/healthz",
      "/favicon.ico",
      "/listings",
      "/sellers/submissions",
      "purchase",
      "confirm",
    ];
    for (const marker of docMarkers) {
      ok(doc.includes(marker), `route table must represent ${marker}`);
    }
    // Methods: each documented operation exists with its verb.
    const spec = readSpec();
    strictEqual(typeof spec.paths["/healthz"].get, "object");
    strictEqual(typeof spec.paths["/favicon.ico"].get, "object");
    strictEqual(typeof spec.paths["/listings"].get, "object");
    strictEqual(typeof spec.paths["/listings/{provider}/{model}"].get, "object");
    strictEqual(typeof spec.paths["/listings/{provider}/{model}/purchase"].post, "object");
    strictEqual(typeof spec.paths["/sellers/submissions"].post, "object");
    strictEqual(typeof spec.paths["/sellers/submissions/{provider}/{model}/confirm"].get, "object");
    strictEqual(typeof spec.paths["/sellers/submissions/{provider}/{model}/confirm"].post, "object");
  });

  it("pins the /listings query vocabulary incl. sort (TOG-6362)", () => {
    const spec = readSpec();
    const params = spec.paths["/listings"].get.parameters;
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    deepStrictEqual(
      Object.keys(byName).sort(),
      ["capability", "limit", "modality", "offset", "q", "sort"],
      "documented query params must match VALID_LISTINGS_QUERY_PARAMS",
    );
    strictEqual(byName.sort.schema.default, "default");
    deepStrictEqual(byName.sort.schema.enum, [
      "default",
      "price-asc",
      "price-desc",
      "name-asc",
      "route-asc",
    ]);
  });

  it("requires requestId on every JSON error schema (TOG-6717)", () => {
    // The triage envelope rides on every JSON error: if a schema drops
    // requestId, the doc lies about the wire shape.
    const spec = readSpec();
    const errorSchemas = [
      "MethodNotAllowed",
      "NotFound",
      "ListingNotFound",
      "PreviewDisabled",
      "PurchaseRefusal",
      "RateLimited",
      "BodyError",
      "InvalidSubmission",
      "NoPendingIntent",
    ];
    for (const name of errorSchemas) {
      const schema = spec.components.schemas[name];
      ok(schema, `schema ${name} must exist`);
      ok(
        (schema.required ?? []).includes("requestId"),
        `schema ${name} must require requestId`,
      );
    }
    // Success shapes stay id-free (error-only scope).
    for (const name of ["HealthProbe", "DetailFragment", "ConfirmModel"]) {
      const schema = spec.components.schemas[name];
      ok(
        !(schema.required ?? []).includes("requestId"),
        `success schema ${name} must not require requestId`,
      );
    }
  });

  describe("live route smoke (flag on)", () => {
    const servers = [];
    async function start(env) {
      const server = createApp(env);
      servers.push(server);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    }
    after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

    it("every documented path answers with its documented success status", async () => {
      const base = await start({ WAYSELECT_PREVIEW: "1" });
      const checks = [
        ["GET /healthz", await fetch(`${base}/healthz`), 200],
        ["GET /favicon.ico", await fetch(`${base}/favicon.ico`), 204],
        ["GET /listings", await fetch(`${base}/listings`), 200],
        [
          "GET /listings/:provider/:model",
          await fetch(`${base}/listings/northstar/alpha-chat`),
          200,
        ],
      ];
      for (const [label, res, expected] of checks) {
        strictEqual(res.status, expected, label);
        await res.arrayBuffer();
      }
      // Purchase refusal carries the triage id with header/body agreement.
      const denialRes = await fetch(`${base}/listings/northstar/alpha-chat/purchase`, {
        method: "POST",
      });
      strictEqual(denialRes.status, 403, "POST purchase");
      const denialHeader = denialRes.headers.get("x-request-id");
      ok(REQUEST_ID_RE.test(denialHeader ?? ""), "403 carries x-request-id");
      const denialBody = await denialRes.json();
      strictEqual(denialBody.error, "preview_only", "403 refusal copy");
      strictEqual(denialBody.requestId, denialHeader, "403 header/body agree");
      // Uppercase segments 404 as misses (TOG-6711), never remap.
      const upper = await fetch(`${base}/listings/Northstar/Alpha-Chat`, {
        headers: { accept: "application/json" },
      });
      strictEqual(upper.status, 404, "uppercase detail");
      strictEqual((await upper.json()).error, "listing_not_found", "uppercase miss shape");
      // Seller intake -> confirm -> receipt flow (uses the synthetic fixture).
      const fixtures = JSON.parse(
        await readFile(
          new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
          "utf8",
        ),
      );
      const intake = await fetch(`${base}/sellers/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixtures.valid),
      });
      strictEqual(intake.status, 200, "POST /sellers/submissions");
      const intakeBody = await intake.json();
      ok(typeof intakeBody.confirmPath === "string", "intake returns confirmPath");
      strictEqual(intakeBody.requestId, undefined, "success JSON carries no requestId");
      const confirmGet = await fetch(`${base}${intakeBody.confirmPath}`, {
        headers: { accept: "application/json" },
      });
      strictEqual(confirmGet.status, 200, "GET confirm");
      await confirmGet.arrayBuffer();
      const confirmPost = await fetch(`${base}${intakeBody.confirmPath}`, {
        method: "POST",
        headers: { accept: "application/json" },
      });
      strictEqual(confirmPost.status, 200, "POST confirm");
      const receipt = await confirmPost.json();
      strictEqual(receipt.recorded, true, "receipt records intent");
      // Missing-intent 404 carries the triage id with header/body agreement.
      const missingRes = await fetch(`${base}/sellers/submissions/northstar/nope/confirm`, {
        headers: { accept: "application/json" },
      });
      strictEqual(missingRes.status, 404, "GET confirm without intent");
      const missingHeader = missingRes.headers.get("x-request-id");
      const missingBody = await missingRes.json();
      strictEqual(missingBody.error, "no_pending_intent", "missing-intent shape");
      strictEqual(missingBody.requestId, missingHeader, "404 header/body agree");
    });
  });
});
