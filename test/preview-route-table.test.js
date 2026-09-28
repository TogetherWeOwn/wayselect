// Route-table coverage for the preview server OpenAPI doc (TOG-6040, gap G3).
//
// The deliverable is docs/preview-server.openapi.json: the machine-readable
// route table for web/server.js. This test pins the acceptance criterion —
// every route in web/server.js is represented in the artifact — two ways:
//   1. Static: each route shape the server source defines appears in the doc.
//   2. Live: each documented path answers on a real server with the
//      documented success status.
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const SPEC_PATH = new URL("../docs/preview-server.openapi.json", import.meta.url);

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
        [
          "POST /listings/:provider/:model/purchase",
          await fetch(`${base}/listings/northstar/alpha-chat/purchase`, { method: "POST" }),
          403,
        ],
      ];
      for (const [label, res, expected] of checks) {
        strictEqual(res.status, expected, label);
        await res.arrayBuffer();
      }
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
    });
  });
});
