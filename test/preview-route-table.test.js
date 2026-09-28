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

// Normalize a server route regex literal to its OpenAPI path template:
// strip the /.../ delimiters, ^...$ anchors and \/ escapes, drop the
// trailing optional slash, and number each ([^/]+) segment so templates
// compare independent of parameter names (/listings/{p1}/{p2} matches
// /listings/{provider}/{model}).
function regexToTemplate(literal, name) {
  const lastSlash = literal.lastIndexOf("/");
  let s = literal.slice(1, lastSlash);
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  let n = 0;
  s = s.replace(/\(\[\^\/\]\+\)/g, () => `{p${++n}}`);
  s = s.replace(/\\\//g, "/");
  s = s.replace(/\/\?$/, "");
  ok(
    !s.includes("(") && !s.includes("\\"),
    `${name} has regex features the drift pin cannot normalize: ${literal}`,
  );
  return s;
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
      "/listings/{provider}/{model}/disputes",
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

  it("tracks every route dispatch site in web/server.js (TOG-6061 drift pin)", () => {
    // Mechanical drift pin: extract the route operands the handler dispatches
    // on from web/server.js source and set-compare against the doc's paths.
    // A new route (or a removed one) fails here naming the side that is
    // stale — update BOTH server.js and docs/preview-server.openapi.json.
    const source = readFileSync(new URL("../web/server.js", import.meta.url), "utf8");
    // Exact-path dispatch: pathname === "/..." and === probePathname "..."
    // operands (excludes the local /healthz/ comment-string mention via the
    // closing-quote/paren anchor). Trailing-slash variants count once.
    const exact = new Set();
    for (const match of source.matchAll(
      /(?:pathname|probePathname)\s*===\s*"(\/[^"]*)"[)]/g,
    )) {
      exact.add(match[1].replace(/\/$/, "") || "/");
    }
    // Regex dispatch: const NAME = /.../ literals actually matched/tested
    // against a request pathname (named *_ROUTE plus any literal probed the
    // same way; ignores unrelated literals like the PORT check).
    const dispatched = new Set();
    for (const match of source.matchAll(/(\w+)\.(match|test)\(\s*(\w+)\s*\)/g)) {
      // pathname.match(NAME) vs NAME.test(pathname): the operand is the
      // side that is NOT the pathname.
      if (match[2] === "match" && /pathname/i.test(match[1])) {
        dispatched.add(match[3]);
      } else if (match[2] === "test" && /pathname/i.test(match[3])) {
        dispatched.add(match[1]);
      }
    }
    // The routeBucket helper mirrors dispatch for rate limiting; it must
    // stay in lockstep (a route missing from its buckets gets a wrong
    // bucket, not a crash, so nothing else would catch the drift).
    const bucketed = new Set();
    for (const match of source.matchAll(/(\w+)\.test\(pathname\)/g)) {
      bucketed.add(match[1]);
    }
    for (const name of [...dispatched].sort()) {
      ok(bucketed.has(name), `routeBucket must bucket ${name} (dispatch/bucket mismatch)`);
    }
    const regexes = {};
    for (const match of source.matchAll(/const\s+(\w+)\s*=\s*(\/[^;]*?);/g)) {
      if (dispatched.has(match[1])) {
        regexes[match[1]] = match[2];
      }
    }
    deepStrictEqual(
      Object.keys(regexes).sort(),
      [...dispatched].sort(),
      "every dispatched regex has a const literal this pin can normalize",
    );
    const live = new Set(exact);
    for (const [name, literal] of Object.entries(regexes)) {
      live.add(regexToTemplate(literal, name));
    }
    // Doc paths normalized the same way: parameter names are irrelevant,
    // trailing slashes count once.
    const spec = readSpec();
    const documented = new Set(
      Object.keys(spec.paths).map((p) => {
        let n = 0;
        return p.replace(/\/$/, "").replace(/\{[^}]+\}/g, () => `{p${++n}}`);
      }),
    );
    const missing = [...live].filter((r) => !documented.has(r));
    const stale = [...documented].filter((r) => ![...live].some((l) => l === r));
    ok(
      missing.length === 0 && stale.length === 0,
      `route table drift: missing from docs: [${missing.join(", ")}]; ` +
        `stale in docs: [${stale.join(", ")}]. Update BOTH web/server.js and docs/preview-server.openapi.json.`,
    );
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
      "disputes",
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
      "disputes",
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
    strictEqual(typeof spec.paths["/listings/{provider}/{model}/disputes"].get, "object");
    strictEqual(typeof spec.paths["/listings/{provider}/{model}/disputes"].post, "object");
    strictEqual(typeof spec.paths["/listings/{provider}/{model}/purchase"].post, "object");
    strictEqual(typeof spec.paths["/sellers/submissions"].post, "object");
    strictEqual(typeof spec.paths["/sellers/submissions/{provider}/{model}/confirm"].get, "object");
    strictEqual(typeof spec.paths["/sellers/submissions/{provider}/{model}/confirm"].post, "object");
  });

  it("pins the /listings query vocabulary incl. sort (TOG-6362)", () => {
    const spec = readSpec();
    const params = spec.paths["/listings"].get.parameters;
    // Query params only: the Accept header entry (TOG-7661 negotiation) is
    // not part of the filter vocabulary.
    const byName = Object.fromEntries(
      params.filter((p) => p.in === "query").map((p) => [p.name, p]),
    );
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
      "IdempotencyKeyRejected",
      "IdempotencyKeyReused",
      "RateLimited",
      "BodyError",
      "InvalidSubmission",
      "InvalidDispute",
      "InvalidFilter",
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
    for (const name of ["HealthProbe", "DetailFragment", "ConfirmModel", "IndexResult", "DisputeList", "DisputeFiled", "DisputeBody"]) {
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
