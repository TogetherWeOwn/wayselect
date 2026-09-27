// Tests for TOG-5725: docs/cli.md select/explain examples.
//
// docs/cli.md carries copy-pasteable select/explain examples with expected
// output, but nothing executed them in CI — the commands and their documented
// output could rot silently. These tests extract every select/explain example
// command from the doc, run it against the checked-in fixtures, and compare
// the normalized output against the doc's own expected-output blocks.
//
// Refresh-proofing: the doc pins literal `--evaluation-time` values, which
// would read as stale once fixtures refresh past the 24h catalog window, so
// the timestamp is substituted with the suite clock (snapshot + 2h, mirroring
// support/helpers.js) before execution. Absolute ISO timestamps are
// normalized on both sides before comparison; relative offsets (which refresh
// preserves) keep the reasons, verdicts, and rankings stable.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { readFixture, evaluationNow } from "../support/helpers.js";
import {
  exampleCommands,
  fencedBlocks,
  normalizeTimestamps,
  substituteClock,
} from "../support/cliDocsExamples.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DOCS_PATH = new URL("../docs/cli.md", import.meta.url);

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

test("TOG-5725: every docs/cli.md select/explain example executes against fixtures", async () => {
  const markdown = await readFile(DOCS_PATH, "utf8");
  const blocks = fencedBlocks(markdown);
  const evaluationTime = evaluationNow().toISOString();

  // Sanity: the doc must still carry the examples this test pins.
  const shBlocks = blocks.filter((block) => block.lang === "sh");
  assert.ok(shBlocks.length >= 5, `expected select/explain sh examples, found ${shBlocks.length}`);

  let executed = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.lang !== "sh") {
      continue;
    }
    const next = blocks[index + 1];
    const expectedText =
      next && next.lang === "text"
        ? next.body
            .split("\n")
            .filter((line) => !line.startsWith("exit="))
            .join("\n")
            .trim()
        : null;

    for (const argv of exampleCommands(block.body)) {
      const args = substituteClock(argv, evaluationTime);
      const expectedCode = args.includes("vision") ? 3 : 0;
      const { code, stdout, stderr } = await runCli(args);
      assert.equal(
        code,
        expectedCode,
        `docs example \`wayselect ${args.join(" ")}\` exited ${code}, expected ${expectedCode}`,
      );
      executed += 1;

      if (expectedCode === 0) {
        assert.equal(stderr, "", `docs example \`wayselect ${args.join(" ")}\` wrote to stderr`);
      }
      if (args.includes("--json")) {
        const payload = JSON.parse(stdout);
        assert.equal(payload.status, "selected");
        assert.equal(payload.selectedRouteId, "northstar/alpha-chat");
        continue;
      }
      if (expectedText !== null) {
        assert.equal(
          normalizeTimestamps(stdout.trim()),
          normalizeTimestamps(expectedText),
          `docs example \`wayselect ${args.join(" ")}\` output drifted from docs/cli.md`,
        );
      } else if (args[0] === "select") {
        assert.match(stdout, /Selected route: northstar\/alpha-chat/);
      } else {
        assert.match(stdout, /verdict: selected northstar\/alpha-chat/);
      }
    }
  }

  assert.ok(executed >= 5, `expected at least 5 doc examples to execute, ran ${executed}`);
});

test("TOG-5725: docs/cli.md examples stay meaningful after a fixture refresh", async () => {
  // The substitution above only works if the request fixture keeps the same
  // request shape the doc examples assume (chat + toolUse + northstar/orbit).
  const request = await readFixture("request.synthetic.json");
  assert.equal(request.selection.operation, "chat");
  assert.deepEqual(request.selection.requiredCapabilities, ["toolUse"]);
  assert.deepEqual(request.selection.providerAllowlist, ["northstar", "orbit"]);
});
