// TOG-6708 (gap R4-02): `Vary: Accept` on content-negotiated routes.
//
// Seller-intake/confirm, the listing-detail shell/fragment, and the 404
// fallback all branch the response body on the request `Accept` header, but
// sent no `Vary: Accept` — a shared cache could store one variant and serve
// it for the other. Contract pinned here:
//   - Every response from those four route shapes carries
//     `Vary: Accept`, on both the HTML and the JSON variant (success and
//     error statuses alike).
//   - Routes that never negotiate stay without it: `/healthz`, the purchase
//     stub, and the index page.
//
// node:test, zero dependencies.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createApp } from "../web/server.js";

const VARY_ACCEPT = "Accept";

describe("Vary: Accept on content-negotiated routes (TOG-6708)", () => {
  const servers = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function vary(base, path, init) {
    const res = await fetch(`${base}${path}`, init);
    await res.text();
    return { status: res.status, vary: res.headers.get("vary") };
  }

  async function readFixtures() {
    return JSON.parse(
      await readFile(
        new URL("../fixtures/seller-submission.synthetic.json", import.meta.url),
        "utf8",
      ),
    );
  }

  it("sends Vary: Accept on both seller-intake variants", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readFixtures();
    const post = (body, accept) =>
      vary(base, "/sellers/submissions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accept === undefined ? {} : { accept }),
        },
        body: JSON.stringify(body),
      });
    // Success: JSON receipt and HTML confirm page.
    const json = await post(fixtures.valid);
    strictEqual(json.status, 200);
    strictEqual(json.vary, VARY_ACCEPT, "intake JSON: Vary: Accept");
    const html = await post(fixtures.valid, "text/html");
    strictEqual(html.status, 200);
    strictEqual(html.vary, VARY_ACCEPT, "intake HTML: Vary: Accept");
    // Rejection page for browsers is negotiated too.
    const forbidden = structuredClone(fixtures.valid);
    forbidden.entry.url = "https://example.invalid/x";
    const rejected = await post(forbidden, "text/html");
    strictEqual(rejected.status, 400);
    strictEqual(rejected.vary, VARY_ACCEPT, "intake rejection HTML: Vary: Accept");
  });

  it("sends Vary: Accept on the confirm screen and the receipt", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fixtures = await readFixtures();
    await vary(base, "/sellers/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixtures.valid),
    });
    const path = "/sellers/submissions/northstar/seller-chat/confirm";
    // GET restates the intent: JSON and HTML variants.
    for (const accept of [undefined, "text/html"]) {
      const confirm = await vary(
        base,
        path,
        accept === undefined ? undefined : { headers: { accept } },
      );
      strictEqual(confirm.status, 200, `confirm accept=${accept}`);
      strictEqual(confirm.vary, VARY_ACCEPT, `confirm accept=${accept}: Vary: Accept`);
    }
    // POST records the receipt: JSON and HTML variants.
    for (const accept of [undefined, "text/html"]) {
      const receipt = await vary(base, path, {
        method: "POST",
        ...(accept === undefined ? {} : { headers: { accept } }),
      });
      strictEqual(receipt.status, 200, `receipt accept=${accept}`);
      strictEqual(receipt.vary, VARY_ACCEPT, `receipt accept=${accept}: Vary: Accept`);
    }
    // Missing intent 404s in both shapes too.
    const missingPath = "/sellers/submissions/northstar/nope/confirm";
    for (const accept of [undefined, "text/html"]) {
      const missing = await vary(
        base,
        missingPath,
        accept === undefined ? undefined : { headers: { accept } },
      );
      strictEqual(missing.status, 404, `missing accept=${accept}`);
      strictEqual(missing.vary, VARY_ACCEPT, `missing accept=${accept}: Vary: Accept`);
    }
  });

  it("sends Vary: Accept on the listing shell, fragment, and misses", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Shell (default HTML) and fragment (`Accept: application/json`).
    const shell = await vary(base, "/listings/northstar/alpha-chat");
    strictEqual(shell.status, 200);
    strictEqual(shell.vary, VARY_ACCEPT, "shell: Vary: Accept");
    const fragment = await vary(base, "/listings/northstar/alpha-chat", {
      headers: { accept: "application/json" },
    });
    strictEqual(fragment.status, 200);
    strictEqual(fragment.vary, VARY_ACCEPT, "fragment: Vary: Accept");
    // Unknown listing: HTML miss by default, JSON miss on negotiation.
    const miss = await vary(base, "/listings/northstar/nope");
    strictEqual(miss.status, 404);
    strictEqual(miss.vary, VARY_ACCEPT, "miss HTML: Vary: Accept");
    const missJson = await vary(base, "/listings/northstar/nope", {
      headers: { accept: "application/json" },
    });
    strictEqual(missJson.status, 404);
    strictEqual(missJson.vary, VARY_ACCEPT, "miss JSON: Vary: Accept");
  });

  it("sends Vary: Accept on the 404 fallback in both shapes", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const json = await vary(base, "/nope");
    strictEqual(json.status, 404);
    strictEqual(json.vary, VARY_ACCEPT, "fallback JSON: Vary: Accept");
    const html = await vary(base, "/nope", { headers: { accept: "text/html" } });
    strictEqual(html.status, 404);
    strictEqual(html.vary, VARY_ACCEPT, "fallback HTML: Vary: Accept");
  });

  it("leaves non-negotiated routes without Vary", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Liveness probe: JSON shape only, never negotiated.
    const health = await vary(base, "/healthz");
    strictEqual(health.status, 200);
    strictEqual(health.vary, null, "/healthz: no Vary");
    // Purchase stub: always JSON regardless of Accept.
    const purchase = await vary(base, "/listings/northstar/alpha-chat/purchase", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    strictEqual(purchase.status, 403);
    strictEqual(purchase.vary, null, "purchase 403: no Vary");
    // Index page: HTML only, no JSON shape.
    const index = await vary(base, "/listings");
    strictEqual(index.status, 200);
    strictEqual(index.vary, null, "index: no Vary");
  });
});
