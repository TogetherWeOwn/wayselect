// TOG-7317: CHANGELOG Unreleased-entry gate pin.
//
// bin/check-changelog-entry reds when a change touches shipped code or its
// tests (src/, web/, bin/, test/) without adding a `- ` bullet naming a TOG
// id under `## Unreleased`. Docs-only, fixture-only, and CHANGELOG-only
// changes skip green. CI runs the script as the changelog-gate workflow on
// pull_request (fetch-depth 0); this test pins the script contract offline
// against scratch git repos in the OS temp dir, plus static pins on the
// workflow shape. No subprocess beyond local git/node, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const gateAbs = join(repoRoot, "bin", "check-changelog-entry");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

// The fixture mirrors the real CHANGELOG shape: the release-note preamble
// mentions the heading name in prose (in backticks) before the real
// heading, so a naive indexOf would slice the preamble instead of the
// section — the gate must anchor the heading to a line start.
const BASE_CHANGELOG = `# Changelog

All notable changes are documented here, newest first.

## Release-note process

1. Every merged PR gets one entry under \`## Unreleased\`, added in the same PR.
2. The reviewer verifies the entry matches the diff.

## Unreleased

- TOG-1000: base entry (base.txt).

## 1.0 — 2026-01-01

- TOG-999: first release.
`;

function git(cwd, args) {
  execFileSync(
    "git",
    ["-c", "user.name=gate-test", "-c", "user.email=gate-test@example.test", ...args],
    { cwd, stdio: "pipe" },
  );
}

function stageRepo() {
  const dir = mkdtempSync(join(tmpdir(), "changelog-gate-"));
  git(dir, ["init", "-b", "main"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "CHANGELOG.md"), BASE_CHANGELOG);
  writeFileSync(join(dir, "src", "app.js"), "export const app = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base", "--quiet"]);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message, "--quiet"]);
}

async function runGate(dir, base) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [gateAbs, "--root", dir, "--base", base, "--head", "HEAD"],
      { cwd: repoRoot },
    );
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

async function scenario(t, mutate) {
  const dir = stageRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  mutate(dir);
  commitAll(dir, "scenario");
  return runGate(dir, base);
}

test("gate --help exits 0 with usage", async () => {
  const { stdout } = await execFileAsync(process.execPath, [gateAbs, "--help"], {
    cwd: repoRoot,
  });
  assert.match(stdout, /usage: node bin\/check-changelog-entry/);
});

test("docs-only change skips green", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(join(dir, "README.md"), "# notes\n");
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CHANGELOG-GATE-SKIP/);
});

test("CHANGELOG-only change skips green", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      BASE_CHANGELOG.replace("- TOG-1000: base entry (base.txt).", "- TOG-1000: base entry, reworded (base.txt)."),
    );
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CHANGELOG-GATE-SKIP/);
});

test("code change without a changelog update reds", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(join(dir, "src", "app.js"), "export const app = 2;\n");
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CHANGELOG-GATE-FAIL/);
  assert.match(result.stdout, /CHANGELOG\.md/);
});

test("code change with an Unreleased TOG bullet passes", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(join(dir, "src", "app.js"), "export const app = 2;\n");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      BASE_CHANGELOG.replace(
        "## Unreleased\n",
        "## Unreleased\n\n- TOG-7317: probe entry (src/app.js).\n",
      ),
    );
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CHANGELOG-GATE-OK/);
});

test("test-only change needs a bullet too", async (t) => {
  const result = await scenario(t, (dir) => {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "probe.test.js"), "import test from 'node:test';\n");
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CHANGELOG-GATE-FAIL/);
});

test("bullet outside Unreleased still reds", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(join(dir, "src", "app.js"), "export const app = 2;\n");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      BASE_CHANGELOG.replace(
        "## 1.0 — 2026-01-01\n",
        "## 1.0 — 2026-01-01\n\n- TOG-7317: probe entry filed under the wrong section.\n",
      ),
    );
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CHANGELOG-GATE-FAIL/);
});

test("changelog edit with no new bullet still reds", async (t) => {
  const result = await scenario(t, (dir) => {
    writeFileSync(join(dir, "src", "app.js"), "export const app = 2;\n");
    writeFileSync(
      join(dir, "CHANGELOG.md"),
      BASE_CHANGELOG.replace("first release.", "first release, reworded."),
    );
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CHANGELOG-GATE-FAIL/);
});

test("unknown argument exits 2 with usage", async () => {
  try {
    await execFileAsync(process.execPath, [gateAbs, "--bogus"], { cwd: repoRoot });
    assert.fail("expected exit 2");
  } catch (error) {
    assert.equal(error.code, 2);
    assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /usage: node bin\/check-changelog-entry/);
  }
});

test("gate script stays stdlib-only with a node entry line", () => {
  const source = read("bin/check-changelog-entry");
  assert.ok(source.split("\n")[0].includes("node"), "P2 picks up node-entry bin scripts");
  assert.ok(!source.includes("node_modules"), "no vendored helpers");
  assert.match(source, /from "node:/, "stdlib-only gate");
});

test("changelog-gate workflow runs the gate on pull_request", () => {
  const workflow = read(".github/workflows/changelog-gate.yml");
  assert.ok(workflow.includes("pull_request"), "gate must run on pull_request");
  assert.ok(workflow.includes("fetch-depth: 0"), "full history is required to diff the PR branch");
  assert.ok(
    workflow.includes("origin/${{ github.base_ref }}"),
    "gate must diff against the PR base branch, not a hardcoded ref",
  );
  assert.ok(
    workflow.includes("node bin/check-changelog-entry"),
    "workflow must run the gate script",
  );
  assert.ok(!workflow.includes("continue-on-error"), "a missing entry must red, never warn");
});
