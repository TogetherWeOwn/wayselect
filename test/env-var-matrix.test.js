// TOG-7321: guard tests for the WAYSELECT_* env-var matrix operator doc.
//
// docs/wayselect-env-var-matrix.md gives one ops row per runtime knob
// (default, scope, who sets). These tests pin the doc against the source
// so drift fails here by design:
//   1. the doc names every WAYSELECT_* key the runtime reads,
//   2. the doc's default/scope claims match the implemented behavior,
//   3. the doc is linked from the README docs index (CONTRIBUTING.md rule).
//
// node:test, stdlib only. No server binds, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isPreviewEnabled } from "../web/preview.js";
import { resolveClientIp } from "../web/rate-limit.js";

const DOC = new URL("../docs/wayselect-env-var-matrix.md", import.meta.url);
const README = new URL("../README.md", import.meta.url);
const PREVIEW_SRC = new URL("../web/preview.js", import.meta.url);
const SERVER_SRC = new URL("../web/server.js", import.meta.url);
const GUARD_SRC = new URL("../support/no-network-guard.js", import.meta.url);

const doc = () => readFileSync(DOC, "utf8");

test("TOG-7321: the matrix doc names all four runtime knobs", () => {
  const text = doc();
  for (const name of [
    "WAYSELECT_PREVIEW",
    "WAYSELECT_TRUSTED_PROXY_IP",
    "WAYSELECT_DETAIL_FRAGMENT_DELAY_MS",
    "WAYSELECT_ALLOW_NETWORK",
  ]) {
    assert.ok(
      text.includes(`\`${name}\``),
      `docs/wayselect-env-var-matrix.md must document \`${name}\``,
    );
  }
});

test("TOG-7321: the matrix doc is linked from the README docs index", () => {
  const readme = readFileSync(README, "utf8");
  assert.ok(
    readme.includes("docs/wayselect-env-var-matrix.md"),
    "README.md docs index must link docs/wayselect-env-var-matrix.md (CONTRIBUTING.md: new docs go in the index)",
  );
});

test("TOG-7321: each knob is read where the doc says it is", () => {
  const preview = readFileSync(PREVIEW_SRC, "utf8");
  const server = readFileSync(SERVER_SRC, "utf8");
  const guard = readFileSync(GUARD_SRC, "utf8");
  assert.ok(
    preview.includes("WAYSELECT_PREVIEW"),
    "web/preview.js must read WAYSELECT_PREVIEW",
  );
  assert.ok(
    server.includes("env.WAYSELECT_TRUSTED_PROXY_IP"),
    "web/server.js must read WAYSELECT_TRUSTED_PROXY_IP",
  );
  assert.ok(
    server.includes("env.WAYSELECT_DETAIL_FRAGMENT_DELAY_MS"),
    "web/server.js must read WAYSELECT_DETAIL_FRAGMENT_DELAY_MS",
  );
  assert.ok(
    guard.includes("WAYSELECT_ALLOW_NETWORK"),
    "support/no-network-guard.js must read WAYSELECT_ALLOW_NETWORK",
  );
});

test("TOG-7321: WAYSELECT_PREVIEW defaults off with the documented truthy set", () => {
  assert.equal(isPreviewEnabled({}), false, "unset flag is off");
  for (const value of ["1", "true", "yes", "on", "  ON  "]) {
    assert.equal(
      isPreviewEnabled({ WAYSELECT_PREVIEW: value }),
      true,
      `${JSON.stringify(value)} enables preview`,
    );
  }
  for (const value of ["0", "false", "", "no"]) {
    assert.equal(
      isPreviewEnabled({ WAYSELECT_PREVIEW: value }),
      false,
      `${JSON.stringify(value)} leaves preview off`,
    );
  }
});

test("TOG-7321: WAYSELECT_TRUSTED_PROXY_IP defaults to direct-remote only", () => {
  assert.equal(
    resolveClientIp("1.2.3.4", "9.9.9.9", null),
    "1.2.3.4",
    "unset trust ignores spoofed XFF",
  );
  assert.equal(
    resolveClientIp("1.2.3.4", "9.9.9.9", "1.2.3.4"),
    "9.9.9.9",
    "trusted peer consults the leftmost XFF entry",
  );
});

test("TOG-7321: the preview flag gates four content route sites", () => {
  const server = readFileSync(SERVER_SRC, "utf8");
  const gates = server.match(/if\s*\(!isPreviewEnabled\(env\)\)/g) ?? [];
  assert.equal(
    gates.length,
    4,
    `expected 4 preview gates in web/server.js (index, intake, confirm, detail), found ${gates.length}`,
  );
});

test("TOG-7321: the fragment knob defaults to no delay and fails open to fast", () => {
  const server = readFileSync(SERVER_SRC, "utf8");
  assert.ok(
    server.includes('WAYSELECT_DETAIL_FRAGMENT_DELAY_MS ?? "0"'),
    'unset knob must default to "0"',
  );
  assert.ok(
    server.includes("Number.isFinite(fragmentDelayMs) && fragmentDelayMs > 0"),
    "only finite values > 0 may delay",
  );
});

test("TOG-7321: the network guard bypass is a strict opt-in", () => {
  const guard = readFileSync(GUARD_SRC, "utf8");
  assert.ok(
    guard.includes('process.env.WAYSELECT_ALLOW_NETWORK === "1"'),
    'bypass must stay a strict === "1" check',
  );
});
