// Double-encoded purchase path segments contract (TOG-6710, gap R4-04
// from TOG-6636).
//
// TOG-6032 pinned the non-collapsing shapes: `%2F` inside a segment decodes
// to a literal `/` that matches no stub (404 `listing_not_found`), and
// `%252F` inside a segment decodes exactly once to a literal `%2F` (also
// 404). What it never pinned is the *collapsing* shape: `%252F` where a `/`
// separator would be — e.g. `/listings/northstar%252Falpha-chat/purchase`.
// Node's URL parser keeps `%25` encoded in `pathname`, so the regex sees two
// segments and the request lands on the *listing* route, not the purchase
// route. On some stacks (double-decode-before-route) that same target would
// split into three segments and hit the purchase stub for a different
// listing — route confusion with a 403 refusal for an id nobody asked for.
//
// This file pins the exact fail-closed behavior, so any future decode or
// routing change fails here first:
//
//   - POST to a collapsing target is the listing route's 405
//     (`method_not_allowed`, `Allow: GET`) — never the 403 purchase refusal,
//     never 200;
//   - GET to a collapsing target is a listing miss (JSON
//     `listing_not_found` when `Accept: application/json`, the HTML 404 page
//     otherwise) — never a purchase body;
//   - double-encoded dot segments (`%252E%252E`) decode once to a literal
//     `%2E%2E` that matches no stub (404 `listing_not_found`), never a
//     traversal;
//   - triple encoding (`%25252F`) still decodes exactly once.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

describe("double-encoded purchase path segments (TOG-6710)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    // Bind IPv4 loopback explicitly: `localhost` may resolve to ::1 on CI,
    // which would make the peer address environment-dependent.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  async function request(base, method, path, headers = {}) {
    const res = await fetch(`${base}${path}`, { method, headers });
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      allow: res.headers.get("allow"),
      text: await res.text(),
    };
  }

  function asJson(response, label) {
    strictEqual(response.contentType, JSON_CT, `${label}: JSON content type`);
    // TOG-6717 rides alongside every error body: this file pins the
    // decoding→status/error-code mapping, not the envelope shape, so the
    // triage id is stripped here. The id contract lives in
    // test/request-id-json-errors.test.js.
    const { requestId: _requestId, ...body } = JSON.parse(response.text);
    return body;
  }

  it("POST to a collapsing %252F target is the listing route's 405, never a purchase refusal", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Single decode leaves a literal `%2F` inside one listing-route segment,
    // so these shape as GET-only listing lookups. A stack that decoded
    // before routing would split them onto the purchase stub instead.
    for (const path of [
      "/listings/northstar%252Falpha-chat/purchase",
      "/listings/northstar%252falpha-chat/purchase",
      "/listings/northstar/alpha-chat%252Fpurchase",
      "/listings/northstar/alpha-chat%252fpurchase",
    ]) {
      const res = await request(base, "POST", path);
      strictEqual(res.status, 405, path);
      strictEqual(res.allow, "GET", `${path}: listing route allows GET only`);
      deepStrictEqual(asJson(res, path), { error: "method_not_allowed" }, path);
      ok(!res.text.includes("preview_only"), `${path}: must not be a purchase refusal`);
    }
  });

  it("GET to a collapsing %252F target is a listing miss, never a purchase body", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const path of [
      "/listings/northstar%252Falpha-chat/purchase",
      "/listings/northstar/alpha-chat%252Fpurchase",
    ]) {
      const json = await request(base, "GET", path, { accept: "application/json" });
      strictEqual(json.status, 404, `${path} (json)`);
      deepStrictEqual(asJson(json, `${path} (json)`), { error: "listing_not_found" }, path);
      const html = await request(base, "GET", path);
      strictEqual(html.status, 404, `${path} (html)`);
      ok(
        String(html.contentType).includes("text/html"),
        `${path} (html): HTML content type`,
      );
      ok(!html.text.includes("preview_only"), `${path} (html): must not be a purchase refusal`);
    }
  });

  it("the real purchase refusal still fires only for the exact three-segment target", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Control: the unmangled target refuses with 403. Every collapsing
    // variant above answers 404/405 instead, so a 403 always means "exact
    // listing, writes disabled" — never route confusion.
    const control = await request(base, "POST", "/listings/northstar/alpha-chat/purchase");
    strictEqual(control.status, 403, "control: exact purchase target refuses");
    deepStrictEqual(
      asJson(control, "control"),
      {
        error: "preview_only",
        message: "Purchases are disabled in preview. No backend writes.",
      },
      "control: exact refusal body",
    );
  });

  it("double-encoded dot segments decode once to a literal miss, never a traversal", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Single decode leaves a literal `%2E%2E` in the id, which matches no
    // stub. A second decode would have produced `..` and must never happen.
    for (const path of [
      "/listings/%252E%252E/alpha-chat/purchase",
      "/listings/northstar/%252E%252E/purchase",
    ]) {
      const res = await request(base, "POST", path);
      strictEqual(res.status, 404, path);
      deepStrictEqual(asJson(res, path), { error: "listing_not_found" }, path);
      ok(!res.text.includes("preview_only"), `${path}: must not be a purchase refusal`);
    }
  });

  it("triple encoding still decodes exactly once (no double-decode)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    // Single decode leaves a literal `%252F` in the id, which matches no
    // stub. Decoding twice would reach `/` and must never happen.
    const res = await request(base, "POST", "/listings/northstar%25252Fevil/alpha-chat/purchase");
    strictEqual(res.status, 404);
    deepStrictEqual(asJson(res, "triple-encoded"), { error: "listing_not_found" });
  });
});
