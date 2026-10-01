// Tests for the TOG-6910 deploy-target gate (scripts/check-deploy-target.mjs).
//
// The gate fails the deploy job when the public base URL is absent (never
// skip-and-pass, TOG-913) and only ever prints env var NAMES, never values.
// Transport model (TOG-7131): the trigger is host-mediated (mirror autodeploy,
// bearer host-side under TOG-7094), so GitHub holds no panel credential and
// the gate checks the URL only. Stdlib only, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, repoRoot), "utf8");
const SCRIPT = ["scripts/check-deploy-target.mjs"];
const ARGS = [
  "--env-name",
  "staging",
  "--url-env",
  "WAYSELECT_STAGING_URL",
];

const SANITIZED_ENV = {
  WAYSELECT_STAGING_URL: "",
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
  WAYSELECT_STAGING_URL: "https://staging-value.example",
};

test("missing target fails with the variable name and no skip branch", async () => {
  const { exit, stderr } = await runGate();
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /WAYSELECT_STAGING_URL/, "names the URL var");
  assert.match(stderr, /TOG-913/, "cites the no-skip-and-pass rule");
});

test("blank values count as missing", async () => {
  const { exit } = await runGate(ARGS, {
    WAYSELECT_STAGING_URL: "   ",
  });
  assert.equal(exit, 1, "whitespace-only values must fail");
});

test("ready path prints names only, never values", async () => {
  const { exit, stdout, stderr } = await runGate(ARGS, READY_ENV);
  assert.equal(exit, 0, stdout);
  assert.match(stdout, /READY/, "reports ready");
  assert.match(stdout, /WAYSELECT_STAGING_URL/, "names the URL var");
  assertNoSecretToken(stdout + stderr, READY_ENV.WAYSELECT_STAGING_URL, "URL");
});

test("unknown flag is a usage error (exit 2)", async () => {
  const { exit, stderr } = await runGate(["--bogus"]);
  assert.equal(exit, 2, stderr);
});

test("missing one --require-env var still fails", async () => {
  const { exit, stderr } = await runGate(
    [...ARGS, "--require-env", "WAYSELECT_STAGING_APP_UUID"],
    {
      WAYSELECT_STAGING_URL: "https://staging-value.example",
    },
  );
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /WAYSELECT_STAGING_APP_UUID/, "names the missing extra var");
});

test("the recipe carries no panel credential and no self-hosted label (TOG-7131)", () => {
  // Static pin on .github/workflows/ci.yml: the host-mediated model holds
  // the bearer host-side (TOG-7094), so the workflow must name no bearer
  // variable, no panel URL, no app UUID, and no Authorization header
  // anywhere, and no runs-on line may select a self-hosted label. (Prose
  // comments may still name self-hosted groups to document WHY those labels
  // can never match this PUBLIC repo — only runs-on lines are pinned.)
  // If the recipe regresses to credentialed transport, this fails before
  // any runner could move a secret.
  const ci = read(".github/workflows/ci.yml");
  for (const forbidden of [
    "COOLIFY_TOKEN",
    "COOLIFY_URL",
    "APP_UUID",
    "Authorization",
  ]) {
    assert.ok(
      !ci.includes(forbidden),
      `ci.yml must not contain ${forbidden} (host-mediated trigger, TOG-7131)`,
    );
  }
  const runsOnLines = ci.split("\n").filter((line) => /runs-on:/.test(line));
  assert.ok(runsOnLines.length > 0, "ci.yml must have runs-on lines to pin");
  for (const line of runsOnLines) {
    assert.ok(
      !line.includes("self-hosted"),
      `runs-on must not select self-hosted (${line.trim()}); PUBLIC repo runners only (TOG-7131)`,
    );
  }
  assert.match(ci, /runs-on: ubuntu-latest/, "deploy jobs run on public runners");
  assert.match(ci, /environment: staging/, "staging keeps its Deployment record");
  assert.match(ci, /environment: production/, "production keeps its Deployment record");
  assert.match(
    ci,
    /check-deploy-target\.mjs --env-name staging/,
    "staging keeps the fail-closed URL gate",
  );
  assert.match(
    ci,
    /check-deploy-target\.mjs --env-name production/,
    "production keeps the fail-closed URL gate",
  );
  assert.match(ci, /wait-for-host-mirror\.mjs/, "mirror settle survives");
  assert.match(
    ci,
    /wait-for-staging-health\.mjs/,
    "health settle poll survives",
  );
  assert.match(
    ci,
    /smoke-wayselect-staging-preview/,
    "post-deploy smoke survives",
  );
});
