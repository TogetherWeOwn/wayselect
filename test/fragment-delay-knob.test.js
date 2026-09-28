// TOG-6383: guard tests for the slow-network knob contract.
//
// web/server.js delays only the listing-detail JSON fragment under
// WAYSELECT_DETAIL_FRAGMENT_DELAY_MS (600 ms path covered in
// test/listing-detail-loading.test.js). These tests pin the rest of the
// operator contract in docs/wayselect-slow-network-knob.md:
//   1. invalid/non-positive knob values mean no delay (fail-open to fast),
//   2. the doc names the exact env var, units, default, and implementation
//      the source uses, so doc drift fails here by design,
//   3. the doc is linked from the README docs index (CONTRIBUTING.md rule).
//
// node:test, stdlib only; server tests bind an ephemeral localhost port.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { createApp } from "../web/server.js";

const DOC = new URL("../docs/wayselect-slow-network-knob.md", import.meta.url);
const README = new URL("../README.md", import.meta.url);
const SERVER = new URL("../web/server.js", import.meta.url);

// The single source of truth for the knob name: the env key the fragment
// branch reads. If the implementation renames the knob, extraction finds
// the new name and the doc assertion below forces the doc to follow.
function knobNameFromSource() {
  const source = readFileSync(SERVER, "utf8");
  const names = new Set(source.match(/WAYSELECT_[A-Z_]*FRAGMENT[A-Z_]*_MS/g) ?? []);
  assert.ok(
    names.size === 1,
    `expected exactly one fragment-delay env key in web/server.js, found ${names.size}`,
  );
  return [...names][0];
}

describe("fragment-delay knob invalid values (TOG-6383)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  // Unset, garbage, empty, and non-positive values must all serve the
  // fragment immediately: the knob fails open to fast, never to a hang.
  for (const value of ["abc", "", "-5", "0"]) {
    it(`no delay for ${JSON.stringify(value)}`, async () => {
      const env = {
        WAYSELECT_PREVIEW: "1",
        WAYSELECT_DETAIL_FRAGMENT_DELAY_MS: value,
      };
      const base = await start(env);
      const begin = Date.now();
      const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
        headers: { accept: "application/json" },
      });
      const ms = Date.now() - begin;
      assert.equal(res.status, 200);
      assert.ok(
        (await res.json()).html.includes("<h1>Alpha Chat</h1>"),
        "fragment still served",
      );
      assert.ok(ms < 500, `fragment must be immediate (took ${ms}ms)`);
    });
  }

  it("unset knob serves the fragment immediately", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const begin = Date.now();
    const res = await fetch(`${base}/listings/northstar/alpha-chat`, {
      headers: { accept: "application/json" },
    });
    const ms = Date.now() - begin;
    assert.equal(res.status, 200);
    assert.ok(ms < 500, `fragment must be immediate (took ${ms}ms)`);
  });
});

test("TOG-6383: the knob doc pins the exact env key the source reads", () => {
  const name = knobNameFromSource();
  const doc = readFileSync(DOC, "utf8");
  assert.ok(
    doc.includes(`\`${name}\``),
    `docs/wayselect-slow-network-knob.md must name the source env key \`${name}\``,
  );
  assert.ok(
    doc.includes("`web/server.js`"),
    "doc must point at the implementation file",
  );
  assert.ok(
    doc.includes("Milliseconds") || doc.includes("milliseconds"),
    "doc must state the units",
  );
});

test("TOG-6383: the knob doc is linked from the README docs index", () => {
  const readme = readFileSync(README, "utf8");
  assert.ok(
    readme.includes("docs/wayselect-slow-network-knob.md"),
    "README.md docs index must link docs/wayselect-slow-network-knob.md (CONTRIBUTING.md: new docs specs go in the index)",
  );
});
