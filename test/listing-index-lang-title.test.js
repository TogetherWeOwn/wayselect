// Tests for TOG-6731 (round-4 gap R4-25): index page lang/title contract
// (test-only). The detail page already pins `<html lang="en">` plus a
// non-empty escaped `<title>` through the shared layout; the index page had
// no such pin. These tests assert the `/listings` index — renderer and live
// server response — carries `<html lang="en">` and exactly one non-empty
// `<title>` with no raw markup inside.

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyFilters } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function assertLangAndTitle(html, label) {
  ok(html.includes('<html lang="en">'), `${label}: <html lang="en">`);
  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)];
  strictEqual(titles.length, 1, `${label}: exactly one <title>`);
  const text = titles[0][1].trim();
  ok(text.length > 0, `${label}: non-empty <title>`);
  ok(!text.includes("<") && !text.includes(">"), `${label}: <title> carries no raw markup`);
  return text;
}

describe("index lang/title contract (TOG-6731)", () => {
  it("renders lang plus a non-empty escaped title", () => {
    const title = assertLangAndTitle(renderListingIndex(STUB_LISTINGS), "renderer");
    strictEqual(title, "Listings — Wayselect");
  });

  it("keeps the contract on the empty state", () => {
    const title = assertLangAndTitle(
      renderListingIndex([], undefined, emptyFilters()),
      "empty state",
    );
    strictEqual(title, "Listings — Wayselect");
  });

  it("serves lang plus title on GET /listings", async () => {
    const server = createApp({ WAYSELECT_PREVIEW: "1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const res = await fetch(`${base}/listings`);
      strictEqual(res.status, 200);
      ok(String(res.headers.get("content-type")).includes("text/html"), "HTML content type");
      const title = assertLangAndTitle(await res.text(), "GET /listings");
      strictEqual(title, "Listings — Wayselect");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
