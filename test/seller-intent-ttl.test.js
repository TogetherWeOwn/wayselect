// Seller-intent TTL (TOG-6716): staged intents expire after
// SELLER_INTENT_TTL_MS, after which confirm GET/POST 404 as missing.
// node:test, zero dependencies; the clock is injected via `options.now`.

import { strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { createApp, SELLER_INTENT_TTL_MS } from "../web/server.js";

async function readSellerFixtures() {
  return JSON.parse(
    await readFile(new URL("../fixtures/seller-submission.synthetic.json", import.meta.url), "utf8"),
  );
}

describe("seller-intent TTL (TOG-6716)", () => {
  const servers = [];
  async function start(options = {}) {
    const server = createApp({ WAYSELECT_PREVIEW: "1" }, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function postSubmission(base, body) {
    const res = await fetch(`${base}/sellers/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it("pins the TTL to one named 15-minute constant", () => {
    strictEqual(SELLER_INTENT_TTL_MS, 15 * 60 * 1000);
  });

  it("serves confirm + receipt for a fresh intent", async () => {
    let t = 1_000_000;
    const base = await start({ now: () => t });
    const fixtures = await readSellerFixtures();

    const accepted = await postSubmission(base, fixtures.valid);
    strictEqual(accepted.status, 200);

    const confirm = await fetch(`${base}/sellers/submissions/northstar/seller-chat/confirm`);
    strictEqual(confirm.status, 200);
    strictEqual((await confirm.json()).routeId, "northstar/seller-chat");

    const receipt = await fetch(
      `${base}/sellers/submissions/northstar/seller-chat/confirm`,
      { method: "POST" },
    );
    strictEqual(receipt.status, 200);
    strictEqual((await receipt.json()).recorded, true);
  });

  it("expires intents at the TTL boundary and revives on re-stage", async () => {
    let t = 2_000_000;
    const base = await start({ now: () => t });
    const fixtures = await readSellerFixtures();
    const path = "/sellers/submissions/northstar/seller-chat/confirm";

    const accepted = await postSubmission(base, fixtures.valid);
    strictEqual(accepted.status, 200);
    const stagedAt = t;

    // One millisecond before expiry the intent is still live for both verbs.
    t = stagedAt + SELLER_INTENT_TTL_MS - 1;
    strictEqual((await fetch(`${base}${path}`)).status, 200);
    strictEqual((await fetch(`${base}${path}`, { method: "POST" })).status, 200);

    // At exactly TTL both verbs 404 as missing.
    t = stagedAt + SELLER_INTENT_TTL_MS;
    const expiredGet = await fetch(`${base}${path}`);
    strictEqual(expiredGet.status, 404);
    strictEqual((await expiredGet.json()).error, "no_pending_intent");
    const expiredPost = await fetch(`${base}${path}`, { method: "POST" });
    strictEqual(expiredPost.status, 404);
    strictEqual((await expiredPost.json()).error, "no_pending_intent");

    // Re-staging after expiry revives the confirm flow.
    const restaged = await postSubmission(base, fixtures.valid);
    strictEqual(restaged.status, 200);
    strictEqual((await fetch(`${base}${path}`)).status, 200);
  });

  it("sweeps stale intents on intake so unread entries cannot leak", async () => {
    let t = 3_000_000;
    const base = await start({ now: () => t });
    const fixtures = await readSellerFixtures();

    const first = await postSubmission(base, fixtures.valid);
    strictEqual(first.status, 200);

    // Past the first intent's TTL, intaking a second intent sweeps the stale one.
    t += SELLER_INTENT_TTL_MS + 1;
    const second = await postSubmission(base, fixtures.minimal);
    strictEqual(second.status, 200);

    const stale = await fetch(`${base}/sellers/submissions/northstar/seller-chat/confirm`);
    strictEqual(stale.status, 404);
    const live = await fetch(`${base}/sellers/submissions/northstar/price-unpublished/confirm`);
    strictEqual(live.status, 200);
  });
});
