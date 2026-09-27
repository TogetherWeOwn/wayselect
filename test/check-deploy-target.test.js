// Tests for the TOG-6910 deploy-target gate (scripts/check-deploy-target.mjs).
//
// The gate fails the deploy job when the Coolify bearer credential, panel URL,
// app UUID or public URL is absent (never skip-and-pass, TOG-913) and only
// ever prints env var NAMES, never values. Stdlib only, no network.

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
  "COOLIFY_TOKEN",
  "--url-env",
  "WAYSELECT_STAGING_URL",
  "--require-env",
  "COOLIFY_URL",
  "--require-env",
  "WAYSELECT_STAGING_APP_UUID",
];

const SANITIZED_ENV = {
  COOLIFY_TOKEN: "",
  WAYSELECT_STAGING_URL: "",
  COOLIFY_URL: "",
  WAYSELECT_STAGING_APP_UUID: "",
};

async function runGate(extraArgs = ARGS, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...SCRIPT, ...extraArgs], {
      cwd: repoRoot,
      env: { ...process.env, ...SANITIZED_ENV, ...env },
    });
    return { exit: 0, stdout, stderr };
  } catch (error) {
    return { exit: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

// Secret-hygiene assertion that CodeQL's incomplete-sanitization check
// accepts: split the captured output on whitespace and require that NO token
// equals a secret value, instead of asserting the value is not a substring.
// A substring check can pass while the value still appears embedded in a
// longer token; exact-token comparison cannot.
function assertNoSecretToken(output, secret, label) {
  const tokens = String(output).split(/\s+/).filter((token) => token !== "");
  assert.ok(!tokens.includes(secret), `${label} value must not appear as an output token`);
}

const READY_ENV = {
  COOLIFY_TOKEN: "bearer-credential-value-abc123",
  WAYSELECT_STAGING_URL: "https://staging-value.example",
  COOLIFY_URL: "https://panel-value.example:8000",
  WAYSELECT_STAGING_APP_UUID: "app-uuid-value-abc123",
};

test("missing target fails with every variable name and no skip branch", async () => {
  const { exit, stderr } = await runGate();
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /COOLIFY_TOKEN/, "names the bearer var");
  assert.match(stderr, /WAYSELECT_STAGING_URL/, "names the URL var");
  assert.match(stderr, /COOLIFY_URL/, "names the panel var");
  assert.match(stderr, /WAYSELECT_STAGING_APP_UUID/, "names the app UUID var");
  assert.match(stderr, /TOG-913/, "cites the no-skip-and-pass rule");
});

test("blank values count as missing", async () => {
  const { exit } = await runGate(ARGS, {
    COOLIFY_TOKEN: "   ",
    WAYSELECT_STAGING_URL: "\t",
    COOLIFY_URL: "x",
    WAYSELECT_STAGING_APP_UUID: "y",
  });
  assert.equal(exit, 1, "whitespace-only values must fail");
});

test("ready path prints names only, never values", async () => {
  const { exit, stdout, stderr } = await runGate(ARGS, READY_ENV);
  assert.equal(exit, 0, stdout);
  assert.match(stdout, /READY/, "reports ready");
  assert.match(stdout, /COOLIFY_TOKEN/, "names the bearer var");
  assertNoSecretToken(stdout + stderr, READY_ENV.COOLIFY_TOKEN, "bearer");
  assertNoSecretToken(stdout + stderr, READY_ENV.WAYSELECT_STAGING_URL, "URL");
  assertNoSecretToken(stdout + stderr, READY_ENV.COOLIFY_URL, "panel");
  assertNoSecretToken(stdout + stderr, READY_ENV.WAYSELECT_STAGING_APP_UUID, "app UUID");
});

test("unknown flag is a usage error (exit 2)", async () => {
  const { exit, stderr } = await runGate(["--bogus"]);
  assert.equal(exit, 2, stderr);
});

test("partial target (bearer only) still fails", async () => {
  const { exit, stderr } = await runGate(ARGS, {
    COOLIFY_TOKEN: "bearer-credential-value-abc123",
  });
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /WAYSELECT_STAGING_URL/, "names the still-missing var");
  assert.match(stderr, /COOLIFY_URL/, "names the still-missing panel var");
  assert.match(stderr, /WAYSELECT_STAGING_APP_UUID/, "names the still-missing app UUID var");
});

test("missing one --require-env var still fails", async () => {
  const { exit, stderr } = await runGate(ARGS, {
    COOLIFY_TOKEN: "bearer-credential-value-abc123",
    WAYSELECT_STAGING_URL: "https://staging-value.example",
    COOLIFY_URL: "https://panel-value.example:8000",
  });
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /WAYSELECT_STAGING_APP_UUID/, "names the missing extra var");
});
