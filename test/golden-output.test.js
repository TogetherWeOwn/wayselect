import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// TOG-4800: golden-output tests for the dry-run explanation. The CLI is
// re-run with pinned flags and its stdout must be byte-identical to the
// checked-in files under test/golden/. Any change to the human or machine
// output shape is a deliberate, reviewed act: regenerate the goldens and say
// why in the commit.
//
// Selection is input-order independent (candidates sort by route id, then by
// synthetic rate): the tie-break edge asserts the reverse allowlist order
// still picks northstar/alpha-chat.

const PINNED = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
  "--evaluation-time",
  "2026-09-24T12:00:00.000Z",
];

async function golden(name) {
  return readFile(new URL(`./golden/${name}`, import.meta.url), "utf8");
}

async function runCli(args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["bin/wayselect", ...args], {
    cwd: new URL("..", import.meta.url),
  });
  return { stdout, stderr };
}

test("select human output is byte-identical to the golden file", async () => {
  const { stdout, stderr } = await runCli(["select", ...PINNED]);

  assert.equal(stderr, "");
  assert.equal(stdout, await golden("select.txt"));
});

test("select --json output is byte-identical to the golden file", async () => {
  const { stdout, stderr } = await runCli(["select", ...PINNED, "--json"]);

  assert.equal(stderr, "");
  assert.equal(stdout, await golden("select.json"));
  // The golden file itself must stay parseable machine output.
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "selected");
  assert.equal(parsed.selectedRouteId, "northstar/alpha-chat");
});

test("explain human output is byte-identical to the golden file", async () => {
  const { stdout, stderr } = await runCli(["explain", ...PINNED]);

  assert.equal(stderr, "");
  assert.equal(stdout, await golden("explain.txt"));
});

test("selection is deterministic under reversed allowlist order", async () => {
  const reversed = PINNED.map((token) =>
    token === "northstar,orbit" ? "orbit,northstar" : token,
  );
  const { stdout } = await runCli(["select", ...reversed, "--json"]);

  assert.equal(JSON.parse(stdout).selectedRouteId, "northstar/alpha-chat");
});
