// Tests for the TOG-8061 buyer trust-signals slice: display-only stub
// ratings (T1 index line, T2 detail section), preview-honest guarantee copy
// (T3), dispute entry point (T4, a link — never a second form per F8),
// fragment parity (T5, one builder), fail-closed rating validation, and the
// JSON-only disputes stub routes (§5 D2–D10 + shape §6).
//
// Copy is pinned in docs/wayselect-buyer-trust-signals.md §2 — no word
// changes here without a Code Reviewer pass on that doc. These tests assert
// the pinned strings verbatim so drift fails by design.
//
// node:test, stdlib + repo modules only. No server binds except the two
// ephemeral createApp instances for the live route probes.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createDisputeStore, validateDisputeBody, VALID_DISPUTE_REASONS } from "../web/disputes.js";
import {
  listingDetailFragment,
  renderListingDetail,
  renderListingDetailShell,
  renderListingIndex,
} from "../web/listing-detail.js";
import { getStubListing } from "../web/stub-listing.js";
import { createApp } from "../web/server.js";

const RATED_BODY =
  "★ 4.6 from 128 stub sales. Stub ratings: synthetic sales history for preview only. Not real buyers.";
const UNRATED_BODY =
  "No ratings yet. This listing has no stub sales history — nothing is hidden, there is just nothing to show.";
const GUARANTEE_BODY =
  "Preview build: purchases are disabled, so you can never be charged here. When buying opens, every purchase is covered — if a listing is materially not as described, report it and get a full refund.";
const REPORT_BODY =
  "Something wrong with this listing? File a stub report — nothing leaves this preview, and filing never charges or refunds anything.";

describe("trust-signal rendering (TOG-8061 §§2–4)", () => {
  it("T1: index rating lines follow the eligibility badge, never before it", () => {
    const html = renderListingIndex([
      getStubListing("northstar", "alpha-chat"),
      getStubListing("northstar", "image-lite"),
      getStubListing("northstar", "unknown-tools"),
    ]);
    ok(html.includes("★ 4.6 · 128 sales"), "alpha-chat rated line");
    ok(html.includes("★ 3.9 · 17 sales"), "image-lite rated line");
    ok(html.includes("No ratings yet"), "unknown-tools unrated line");
    for (const line of ["★ 4.6 · 128 sales", "★ 3.9 · 17 sales", "No ratings yet"]) {
      const badgePos = html.indexOf("badge-");
      ok(badgePos !== -1 && badgePos < html.indexOf(line), `badge precedes ${line}`);
    }
  });

  it("T2–T4: detail sections render verbatim in fixed order", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    for (const label of ['aria-label="Seller rating"', 'aria-label="Purchase guarantee"', 'aria-label="Report a problem"']) {
      ok(html.includes(label), `detail carries ${label}`);
    }
    ok(html.includes(RATED_BODY), "T2 rated body verbatim");
    ok(html.includes(GUARANTEE_BODY), "T3 body verbatim");
    ok(html.includes(REPORT_BODY), "T4 body verbatim");
    ok(html.includes("Report a problem (stub)"), "T4 button copy");
    const order = [
      html.indexOf('aria-label="Eligibility"'),
      html.indexOf('aria-label="Seller rating"'),
      html.indexOf('aria-label="Purchase guarantee"'),
      html.indexOf('aria-label="Report a problem"'),
      html.indexOf("Capabilities"),
    ];
    ok(order.every((pos) => pos !== -1), "all five sections present");
    deepStrictEqual([...order].sort((a, b) => a - b), order, "fixed section order");
  });

  it("T2: unrated listing renders the unrated body, never a default score", () => {
    const html = renderListingDetail(getStubListing("northstar", "unknown-tools"));
    ok(html.includes('aria-label="Seller rating"'), "section present");
    ok(html.includes(UNRATED_BODY), "unrated body verbatim");
  });

  it("fail-closed: bad rating data renders the unrated copy, page still 200-shaped", () => {
    for (const bad of [
      { average: NaN, sales: 10 },
      { average: 6, sales: 10 },
      { average: -1, sales: 10 },
      { average: 4.6, sales: -1 },
      { average: 4.6, sales: 1.5 },
      { average: "4.6", sales: 10 },
      null,
      [],
    ]) {
      const html = renderListingDetail({ ...getStubListing("northstar", "alpha-chat"), rating: bad });
      ok(html.includes(UNRATED_BODY), `bad rating ${JSON.stringify(bad)} fails closed`);
      ok(!html.includes("★ 4.6 from"), "no stars without a valid count");
    }
  });

  it("T4: the dispute entry is a link, and the page keeps exactly one form (F8)", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    ok(
      html.includes('href="/listings/northstar/alpha-chat/disputes"'),
      "T4 links to the §6 disputes route",
    );
    const forms = html.match(/<form[\s>]/g) ?? [];
    strictEqual(forms.length, 1, "exactly one form (the purchase stub) per F8");
  });

  it("T5: shell noscript, JSON fragment, and full render share one builder", () => {
    for (const id of ["alpha-chat", "image-lite", "unknown-tools"]) {
      const listing = getStubListing("northstar", id);
      const fragment = listingDetailFragment(listing).html;
      const full = renderListingDetail(listing);
      const shell = renderListingDetailShell(listing);
      for (const needle of [
        'aria-label="Seller rating"',
        'aria-label="Purchase guarantee"',
        'aria-label="Report a problem"',
      ]) {
        ok(fragment.includes(needle), `${id} fragment carries ${needle}`);
        ok(full.includes(needle), `${id} full render carries ${needle}`);
        ok(shell.includes(needle), `${id} shell noscript carries ${needle}`);
      }
      ok(shell.includes(fragment), `${id} shell noscript embeds the fragment body verbatim`);
      ok(full.includes(fragment), `${id} full render embeds the fragment body verbatim`);
    }
  });

  it("N1: detail pages carry no payout surface", () => {
    for (const id of ["alpha-chat", "image-lite", "unknown-tools"]) {
      const html = renderListingDetail(getStubListing("northstar", id));
      ok(!html.toLowerCase().includes("payout"), `${id} has no payout surface`);
    }
  });
});

describe("dispute validator (TOG-8061 shape §6)", () => {
  it("accepts the pinned valid body, trimming the buyer", () => {
    deepStrictEqual(validateDisputeBody({ buyer: "  mia  ", reason: "not_as_described" }), {
      ok: true,
      value: { buyer: "mia", reason: "not_as_described" },
    });
    deepStrictEqual(
      VALID_DISPUTE_REASONS,
      ["not_as_described", "never_delivered", "billing_issue", "other"],
    );
  });

  it("rejects missing/blank/overlong buyers, unknown reasons, unknown fields", () => {
    for (const bad of [
      { reason: "other" },
      { buyer: "   ", reason: "other" },
      { buyer: "x".repeat(121), reason: "other" },
      { buyer: "mia", reason: "nope" },
      { buyer: "mia", reason: "other", evil: true },
      { buyer: 42, reason: "other" },
      null,
      [],
      "buyer",
    ]) {
      const result = validateDisputeBody(bad);
      strictEqual(result.ok, false, `${JSON.stringify(bad)} must fail`);
    }
  });

  it("accepts 120-char buyers at the boundary, rejects 121", () => {
    strictEqual(validateDisputeBody({ buyer: "b".repeat(120), reason: "other" }).ok, true);
    strictEqual(validateDisputeBody({ buyer: "b".repeat(121), reason: "other" }).ok, false);
  });
});

describe("dispute store (TOG-8061 §5 D2–D4)", () => {
  it("starts empty, files deterministic dispute-N ids per listing", () => {
    const store = createDisputeStore();
    deepStrictEqual(store.list("northstar/alpha-chat"), []);
    deepStrictEqual(store.file("northstar/alpha-chat", { buyer: "mia", reason: "other" }), {
      id: "dispute-1",
      listing: "northstar/alpha-chat",
      buyer: "mia",
      reason: "other",
      status: "open",
    });
    deepStrictEqual(store.file("northstar/alpha-chat", { buyer: "zo", reason: "other" }).id, "dispute-2");
    strictEqual(store.list("northstar/image-lite").length, 0, "ids are per listing");
    strictEqual(store.file("northstar/image-lite", { buyer: "zo", reason: "other" }).id, "dispute-1");
  });
});

describe("disputes routes live (TOG-8061 §5 D2–D10)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function json(base, path, method, body, headers) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it("D2–D4: empty log, file dispute-1, log contains it open", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const fresh = await json(base, "/listings/northstar/alpha-chat/disputes", "GET");
    strictEqual(fresh.status, 200);
    deepStrictEqual(fresh.body, { listing: "northstar/alpha-chat", disputes: [] });
    const filed = await json(base, "/listings/northstar/alpha-chat/disputes", "POST", {
      buyer: "mia",
      reason: "not_as_described",
    });
    strictEqual(filed.status, 201);
    deepStrictEqual(filed.body, {
      id: "dispute-1",
      listing: "northstar/alpha-chat",
      buyer: "mia",
      reason: "not_as_described",
      status: "open",
    });
    const afterFile = await json(base, "/listings/northstar/alpha-chat/disputes", "GET");
    strictEqual(afterFile.status, 200);
    ok(afterFile.body.disputes.some((d) => d.id === "dispute-1" && d.status === "open"));
  });

  it("D5+D7: bad shapes and malformed bodies 400 invalid_dispute naming reasons", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const path = "/listings/northstar/alpha-chat/disputes";
    for (const bad of [
      { reason: "other" },
      { buyer: "   ", reason: "other" },
      { buyer: "x".repeat(121), reason: "other" },
      { buyer: "mia", reason: "nope" },
      { buyer: "mia", reason: "other", evil: true },
    ]) {
      const res = await json(base, path, "POST", bad);
      strictEqual(res.status, 400, JSON.stringify(bad));
      strictEqual(res.body.error, "invalid_dispute");
      deepStrictEqual(res.body.validReasons, VALID_DISPUTE_REASONS);
    }
    const malformed = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    strictEqual(malformed.status, 400);
    strictEqual((await malformed.json()).error, "invalid_dispute");
    const wrongType = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ buyer: "mia", reason: "other" }),
    });
    strictEqual(wrongType.status, 400);
    strictEqual((await wrongType.json()).error, "invalid_dispute");
  });

  it("D6: unknown listings 404 as misses", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await json(base, "/listings/northstar/nope/disputes", "POST", {
      buyer: "mia",
      reason: "other",
    });
    strictEqual(res.status, 404);
    strictEqual(res.body.error, "not_found");
  });

  it("D8: evil buyer input accepted as JSON-encoded data", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await json(base, "/listings/northstar/alpha-chat/disputes", "POST", {
      buyer: "<script>alert(1)</script>",
      reason: "other",
    });
    strictEqual(res.status, 201);
    strictEqual(res.body.buyer, "<script>alert(1)</script>");
  });

  it("D9: flag off gates both disputes methods with 404", async () => {
    const base = await start({});
    const path = "/listings/northstar/alpha-chat/disputes";
    const get = await json(base, path, "GET");
    strictEqual(get.status, 404);
    ok((get.body.error ?? "").includes("preview"), "flag named");
    const post = await json(base, path, "POST", { buyer: "mia", reason: "other" });
    strictEqual(post.status, 404);
    ok((post.body.error ?? "").includes("preview"), "flag named");
  });

  it("D10: purchase still 403 after filing", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    await json(base, "/listings/northstar/alpha-chat/disputes", "POST", {
      buyer: "mia",
      reason: "other",
    });
    const purchase = await json(base, "/listings/northstar/alpha-chat/purchase", "POST", {});
    strictEqual(purchase.status, 403);
    strictEqual(purchase.body.error, "preview_only");
  });

  it("wrong methods 405 with Allow: GET, POST", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const method of ["PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const res = await fetch(`${base}/listings/northstar/alpha-chat/disputes`, { method });
      strictEqual(res.status, 405, method);
      strictEqual(res.headers.get("allow"), "GET, POST", `${method} Allow`);
      await res.arrayBuffer();
    }
  });
});
