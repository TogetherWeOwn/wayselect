// Tests for the TOG-6910 deploy-target gate (scripts/check-deploy-target.mjs).
//
// The gate fails the deploy job when the Coolify hook + public URL are absent
// (never skip-and-pass, TOG-913) and only ever prints env var NAMES, never
// values. Stdlib only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const SCRIPT = ["scripts/check-deploy-target.mjs"];
const ARGS = [
  "--env-name",
  "staging",
  "--hook-env",
  "COOLIFY_STAGING_DEPLOY_HOOK",
  "--url-env",
  "WAYSELECT_STAGING_URL",
];

async function runGate(extraArgs = ARGS, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...SCRIPT, ...extraArgs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COOLIFY_STAGING_DEPLOY_HOOK: "",
        WAYSELECT_STAGING_URL: "",
        ...env,
      },
    });
    return { exit: 0, stdout, stderr };
  } catch (error) {
    return { exit: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("missing target fails with both variable names and no skip branch", async () => {
  const { exit, stderr } = await runGate();
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /COOLIFY_STAGING_DEPLOY_HOOK/, "names the hook var");
  assert.match(stderr, /WAYSELECT_STAGING_URL/, "names the URL var");
  assert.match(stderr, /TOG-913/, "cites the no-skip-and-pass rule");
});

test("blank values count as missing", async () => {
  const { exit } = await runGate(ARGS, {
    COOLIFY_STAGING_DEPLOY_HOOK: "   ",
    WAYSELECT_STAGING_URL: "\t",
  });
  assert.equal(exit, 1, "whitespace-only values must fail");
});

test("ready path prints names only, never values", async () => {
  const hook = "hook-secret-value-abc123";
  const url = "https://staging-secret-value.example";
  const { exit, stdout } = await runGate(ARGS, {
    COOLIFY_STAGING_DEPLOY_HOOK: hook,
    WAYSELECT_STAGING_URL: url,
  });
  assert.equal(exit, 0, stdout);
  assert.match(stdout, /READY/, "reports ready");
  assert.ok(!stdout.includes(hook), "hook value must not appear in output");
  assert.ok(!stdout.includes(url), "URL value must not appear in output");
});

test("unknown flag is a usage error (exit 2)", async () => {
  const { exit, stderr } = await runGate(["--bogus"]);
  assert.equal(exit, 2, stderr);
});

test("partial target (hook only) still fails", async () => {
  const { exit, stderr } = await runGate(ARGS, {
    COOLIFY_STAGING_DEPLOY_HOOK: "https://hook.example/token",
  });
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /WAYSELECT_STAGING_URL/, "names the still-missing var");
});
