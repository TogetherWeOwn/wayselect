// Negative control for the docs/cli.md doctest job (TOG-5743).
//
// The doctest harness must FAIL on a deliberate docs typo: if a writer edits
// the doc's expected output without changing the CLI, both the dedicated CI
// job (`npm run doctest:cli`, job `cli-doctests`) and this in-suite test must
// go red. This test proves fail-loudness by copying the doc to a scratch dir,
// corrupting one expected-output token in a `text` block, and asserting the
// harness rejects the mutated copy (exit non-zero, FAIL on stderr) — without
// touching the real doc.
//
// The harness and this control share parsing via support/cliDocsExamples.js,
// so a fence-format change in the doc keeps both in step.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { firstExampleWithExpectation } from "../support/cliDocsExamples.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DOCS_PATH = new URL("../docs/cli.md", import.meta.url);

test("TOG-5743: doctest harness fails on a deliberate docs/cli.md typo", async () => {
  const markdown = await readFile(DOCS_PATH, "utf8");
  const probe = firstExampleWithExpectation(markdown);
  assert.ok(probe, "expected docs/cli.md to carry a select/explain example with a text block");

  // Corrupt exactly one expected-output token in the doc copy. The probe
  // covers the pinned `Selected route:` / `verdict:` verdict strings, so a
  // route-name typo is representative of the drift class the job guards.
  const mutated = markdown.replace(probe.expectedText, `${probe.expectedText}\nTYPO-PROBE`);
  assert.notEqual(mutated, markdown, "mutation must change the doc copy");

  const dir = await mkdtemp(join(tmpdir(), "wayselect-doctest-typo-"));
  const typoDoc = join(dir, "cli-typo.md");
  await writeFile(typoDoc, mutated);

  let exitCode = 0;
  let stderr = "";
  try {
    await execFileAsync(process.execPath, ["bin/check-cli-docs", "--doc", typoDoc], {
      cwd: repoRoot,
    });
  } catch (error) {
    exitCode = error.code;
    stderr = String(error.stderr ?? "");
  }
  assert.notEqual(exitCode, 0, "harness must reject the mutated doc copy");
  assert.match(stderr, /FAIL/, "harness must print a FAIL line for the typo");
});
