// Tests for TOG-8618: docs explain --json examples as doctests.
//
// docs/cli.md carries a copy-pasteable `explain --json` example with its
// expected JSON output, but nothing executed that pairing in CI — the command
// and its documented payload could rot silently. These tests extract every
// documented `explain ... --json` invocation from the docs, run it against
// the checked-in fixtures, and compare the normalized output against the
// doc's own expected-output block. Doc/code drift fails this file.
//
// Distinct from TOG-5725 (`test/cli-docs-examples.test.js`, every cli.md
// select/explain example incl. human output) and TOG-5734
// (`test/cli-json-contract.test.js`, machine-contract snapshots): this file
// pins only the documented `explain --json` invocations, in every doc that
// carries one.
//
// Refresh-proofing: the doc pins literal `--evaluation-time` values, which
// would read as stale once fixtures refresh past the 24h catalog window, so
// the timestamp is substituted with the suite clock (snapshot + 2h, mirroring
// support/helpers.js) before execution. Absolute ISO timestamps and the
// catalog snapshot hash move on refresh, so both sides are normalized before
// the byte comparison; the normalized-away fields are asserted well-formed
// separately. Ranks, reasons, rates, and the verdict are refresh-stable and
// compared exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { evaluationNow } from "../support/helpers.js";
import { validateCliJson } from "../src/validate-cli-json.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
// Docs scanned for runnable `explain --json` examples. docs/cli.md is the
// canonical reference; the buyer-listing spec names the same machine fields
// in prose (B3) and is scanned too, so a runnable pin added there is picked
// up automatically.
const DOC_PATHS = ["../docs/cli.md", "../docs/wayselect-buyer-listing.md"];

function normalizeVolatile(serialized) {
  return serialized
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>")
    .replace(/sha256:[a-f0-9]{64}/g, "<HASH>");
}

// Split markdown into an ordered list of fenced blocks: { lang, body }.
function fencedBlocks(markdown) {
  const blocks = [];
  const pattern = /```(\w+)\n(.*?)```/gs;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ lang: match[1], body: match[2] });
  }
  return blocks;
}

// Extract runnable `node bin/wayselect explain ... --json` commands from an
// sh block: join continuations, cut `; echo ...` suffixes.
function explainJsonCommands(shBody) {
  const joined = shBody.replace(/\\\n/g, " ");
  const commands = [];
  for (const rawLine of joined.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("node bin/wayselect")) {
      continue;
    }
    const argv = line
      .split(";")[0]
      .trim()
      .split(/\s+/)
      .slice(2);
    if (argv[0] !== "explain" || !argv.includes("--json")) {
      continue;
    }
    commands.push(argv);
  }
  return commands;
}

function substituteClock(argv, evaluationTime) {
  return argv.map((token, index) =>
    argv[index - 1] === "--evaluation-time" ? evaluationTime : token,
  );
}

async function runCli(argv) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/wayselect", ...argv],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function assertWellFormedVolatile(payload) {
  for (const field of [
    "evaluationTime",
    "provenance.snapshotTimestamp",
    "provenance.fetchedAt",
  ]) {
    const value = field.split(".").reduce((node, key) => node[key], payload);
    assert.match(
      value,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      `${field} must be an ISO timestamp, got: ${value}`,
    );
  }
  assert.match(payload.provenance.snapshotHash, /^sha256:[a-f0-9]{64}$/);
}

test("TOG-8618: every documented explain --json example executes and matches its doc output", async () => {
  const evaluationTime = evaluationNow().toISOString();
  let executed = 0;

  for (const docPath of DOC_PATHS) {
    const markdown = await readFile(new URL(docPath, import.meta.url), "utf8");
    const blocks = fencedBlocks(markdown);

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.lang !== "sh") {
        continue;
      }
      const next = blocks[index + 1];
      for (const argv of explainJsonCommands(block.body)) {
        assert.equal(
          next?.lang,
          "json",
          `documented \`wayselect ${argv.join(" ")}\` in ${docPath} must be followed by its expected JSON output`,
        );
        const args = substituteClock(argv, evaluationTime);
        const { code, stdout, stderr } = await runCli(args);
        assert.equal(
          code,
          0,
          `docs example \`wayselect ${args.join(" ")}\` exited ${code}, expected 0`,
        );
        assert.equal(
          stderr,
          "",
          `docs example \`wayselect ${args.join(" ")}\` wrote to stderr`,
        );

        const payload = JSON.parse(stdout);
        assert.equal(payload.command, "explain");
        assert.equal(payload.status, "selected");
        assert.equal(payload.selectedRouteId, "northstar/alpha-chat");
        assert.deepEqual(validateCliJson(payload), { ok: true });
        assertWellFormedVolatile(payload);

        const expected = JSON.parse(next.body);
        assert.deepEqual(
          validateCliJson(expected),
          { ok: true },
          "documented explain --json output must satisfy the v1 contract",
        );
        assert.equal(
          normalizeVolatile(JSON.stringify(payload, null, 2)),
          normalizeVolatile(JSON.stringify(expected, null, 2)),
          `explain --json output drifted from ${docPath}`,
        );
        executed += 1;
      }
    }
  }

  assert.ok(
    executed >= 1,
    `expected at least 1 documented explain --json example to execute, ran ${executed}`,
  );
});

test("TOG-8618: documented explain --json stays meaningful after a fixture refresh", async () => {
  // The substitution above only works if the canonical example keeps the
  // request shape the checked-in fixture assumes (chat + toolUse +
  // northstar/orbit selecting northstar/alpha-chat).
  const markdown = await readFile(new URL(DOC_PATHS[0], import.meta.url), "utf8");
  const blocks = fencedBlocks(markdown);
  const documented = blocks.some(
    (block) =>
      block.lang === "sh" &&
      explainJsonCommands(block.body).some(
        (argv) =>
          argv.includes("chat") &&
          argv.includes("toolUse") &&
          argv.includes("northstar,orbit"),
      ),
  );
  assert.ok(documented, "docs must retain the canonical explain --json example");
});
