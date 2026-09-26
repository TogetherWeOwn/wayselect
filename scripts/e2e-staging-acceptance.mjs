#!/usr/bin/env node
/**
 * E2E staging acceptance for the Wayselect CLI slices (TOG-4873).
 *
 * Covers TOG-4830 (versioned catalog-entry schema, fail-closed validation)
 * and TOG-4836 (dry-run eligibility explain) with one recorded run.
 * No CLI code changes live here; this script only exercises the slices.
 *
 * Usage (from the wayselect repo root):
 *   node scripts/e2e-staging-acceptance.mjs [--out evidence.json] [--keep-tmp]
 *
 * Env:
 *   WAYSELECT_STAGING_ENDPOINT  Staging catalog endpoint. When set, the script
 *                               attempts to publish the valid test entry there
 *                               (HTTP POST) and records the result. When unset
 *                               (current state: no staging endpoint is declared
 *                               anywhere in repo history), the publish step runs
 *                               as a local validator gate and records the
 *                               endpoint as "undeclared".
 *
 * Exit code is 0 only when every check passes. Evidence JSON is always written
 * to --out (default ./e2e-evidence.json).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_REF = "origin/tog-4404-fixture-slice";
const SCHEMA_REF =
  "origin/TOG-4830-wayselect-catalog-entry-json-schema-fail-closed-validation-tests";

function parseArgs(argv) {
  const out = { out: join(REPO_ROOT, "e2e-evidence.json"), keepTmp: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.out = resolve(argv[++i]);
    else if (argv[i] === "--keep-tmp") out.keepTmp = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write(
        "Usage: node scripts/e2e-staging-acceptance.mjs [--out evidence.json] [--keep-tmp]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

async function git(args, cwd = REPO_ROOT) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function scratchRoot(dest) {
  return resolve(dest, "..");
}

async function extract(ref, paths, dest) {
  const archive = await new Promise((resolveP, rejectP) => {
    const chunks = [];
    const child = execFile("git", ["archive", ref, ...paths], {
      cwd: REPO_ROOT,
      encoding: "buffer",
    });
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", rejectP);
    child.on("close", (code) =>
      code === 0
        ? resolveP(Buffer.concat(chunks))
        : rejectP(new Error(`git archive ${ref} exited ${code}`)),
    );
  });
  // tar needs the archive on stdin; use a file round-trip instead.
  const tmpTar = join(scratchRoot(dest), "slice.tar");
  writeFileSync(tmpTar, archive);
  await execFileAsync("tar", ["-xf", tmpTar, "-C", dest]);
  rmSync(tmpTar);
}

const checks = [];
function check(name, fn) {
  return (async () => {
    try {
      const detail = await fn();
      checks.push({ name, status: "pass", detail });
      process.stdout.write(`PASS  ${name}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({ name, status: "fail", detail });
      process.stdout.write(`FAIL  ${name}: ${detail}\n`);
    }
  })();
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertMatch(actual, re, label) {
  if (typeof actual !== "string" || !re.test(actual))
    throw new Error(`${label}: ${JSON.stringify(actual)} does not match ${re}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync(join(tmpdir(), "tog-4873-e2e-"));
  const cliDir = join(scratch, "cli");
  const schemaDir = join(scratch, "schema");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(schemaDir, { recursive: true });

  const cliSha = await git(["rev-parse", `${CLI_REF}^{commit}`]);
  const schemaSha = await git(["rev-parse", `${SCHEMA_REF}^{commit}`]);
  const repoHead = await git(["rev-parse", "HEAD"]);
  process.stdout.write(`CLI slice    ${CLI_REF} @ ${cliSha}\n`);
  process.stdout.write(`Schema slice ${SCHEMA_REF} @ ${schemaSha}\n`);

  await extract(CLI_REF, ["bin", "src", "fixtures", "support"], cliDir);
  await extract(SCHEMA_REF, ["schema", "src", "test"], schemaDir);

  // Schema slice needs ajv; install into the scratch copy only.
  await execFileAsync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-save", "ajv@^8.17.1", "ajv-formats@^3.0.1"],
    { cwd: schemaDir },
  );

  const stagingEndpoint = process.env.WAYSELECT_STAGING_ENDPOINT ?? null;

  const validatorUrl =
    new URL("file://" + join(schemaDir, "src", "validate-catalog-entry.js")).href;
  const { validateCatalogEntry } = await import(validatorUrl);
  const fixture = (name) =>
    JSON.parse(readFileSync(join(schemaDir, "test", "fixtures", name), "utf8"));

  // --- Step 1: publish path (validator gate) + fail-closed rejections ---
  await check("publish: valid entry accepted", async () => {
    const result = validateCatalogEntry(fixture("valid.json"));
    assertEqual(result.ok, true, "valid entry");
    if (stagingEndpoint) {
      const res = await fetch(stagingEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixture("valid.json")),
      });
      if (!res.ok) throw new Error(`staging POST -> HTTP ${res.status}`);
      return `accepted locally; staging POST -> HTTP ${res.status}`;
    }
    return "accepted locally; no staging endpoint declared, POST skipped";
  });

  for (const [name, pattern] of [
    ["malformed.json", /Catalog entry rejected/],
    ["stale.json", /unsupported schemaVersion/],
    ["unknown-field.json", /additionalProperties|must NOT have additional/],
  ]) {
    await check(`fail-closed: ${name} rejected with provenance`, async () => {
      const result = validateCatalogEntry(fixture(name));
      assertEqual(result.ok, false, `${name} ok flag`);
      assertMatch(result.error, pattern, `${name} error`);
      assertMatch(
        result.error,
        /source=https:\/\/models\.dev\/api\.json fetchedAt=/,
        `${name} provenance`,
      );
      return result.error.slice(0, 160);
    });
  }

  // --- Step 2: dry-run eligibility explain via the CLI binary ---
  async function runCli(extraArgs = []) {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(cliDir, "bin", "wayselect"), ...extraArgs],
      { cwd: cliDir },
    );
    if (stderr) throw new Error(`CLI stderr: ${stderr.slice(0, 200)}`);
    return JSON.parse(stdout);
  }

  await check("dry-run: default fixtures select northstar/alpha-chat", async () => {
    const out = await runCli();
    assertEqual(out.mode, "dry-run-only", "mode");
    assertEqual(out.selection.status, "selected", "selection.status");
    assertEqual(out.selection.dryRun, true, "selection.dryRun");
    assertEqual(
      out.selection.policy,
      "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
      "selection.policy",
    );
    assertMatch(out.selection.rateDisclaimer, /not actual cost/, "rateDisclaimer");
    assertEqual(out.selection.selected.routeId, "northstar/alpha-chat", "selected route");
    if (!Array.isArray(out.selection.candidates) || out.selection.candidates.length === 0)
      throw new Error("candidates list missing or empty");
    for (const c of out.selection.candidates) {
      if (typeof c.routeId !== "string" || typeof c.eligible !== "boolean" || !Array.isArray(c.reasons))
        throw new Error(`candidate missing explain fields: ${JSON.stringify(c).slice(0, 120)}`);
    }
    assertEqual(out.transport.adapter, "fake", "transport.adapter");
    assertEqual(out.transport.networkUsed, false, "transport.networkUsed");
    return `selected ${out.selection.selected.routeId}; ${out.selection.candidates.length} candidates explained; networkUsed=false`;
  });

  await check("dry-run: impossible request explains no-eligible-route", async () => {
    // The CLI reads the full request envelope and passes `.selection`
    // to eligibility, so the override file must keep the envelope shape.
    const reqPath = join(scratch, "request-no-eligible.json");
    writeFileSync(
      reqPath,
      JSON.stringify({
        evaluationTime: "2026-09-24T12:00:00.000Z",
        maxEvidenceAgeHours: 72,
        selection: {
          operation: "chat",
          requiredCapabilities: ["reasoning"],
          providerAllowlist: ["northstar"],
        },
        syntheticPayload: { prompt: "Return a synthetic greeting." },
      }),
    );
    const out = await runCli(["--request", reqPath]);
    assertEqual(out.mode, "dry-run-only", "mode");
    assertEqual(out.selection.status, "no-eligible-route", "selection.status");
    assertEqual(out.selection.selected, null, "selection.selected");
    if (!out.selection.candidates.every((c) => c.eligible === false))
      throw new Error("expected every candidate to be ineligible");
    return `${out.selection.candidates.length} candidates, all ineligible with reasons`;
  });

  const failed = checks.filter((c) => c.status === "fail");
  const evidence = {
    issue: "TOG-4873",
    ranAt: new Date().toISOString(),
    repoHead,
    cli: { ref: CLI_REF, sha: cliSha },
    schema: { ref: SCHEMA_REF, sha: schemaSha },
    stagingEndpoint: stagingEndpoint ?? "undeclared (local validator run)",
    checks,
    defects: [
      "D1 (CLI slice / TOG-4836): bin/wayselect exposes no --dry-run flag; dry-run is the implicit only mode (mode=dry-run-only). Step 2 verified the mode field instead.",
      "D2 (staging infra): no staging catalog endpoint is declared in any repo history; step 1 ran as a local validator gate only.",
    ],
    verdict: failed.length === 0 ? "PASS" : "NEEDS WORK",
  };
  writeFileSync(args.out, JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(
    `\nEvidence: ${args.out}\nVerdict: QA ${cliSha.slice(0, 7)}/${schemaSha.slice(0, 7)}: ${evidence.verdict} (${checks.length - failed.length}/${checks.length} checks passed)\n`,
  );

  if (!args.keepTmp) rmSync(scratch, { recursive: true, force: true });
  else process.stdout.write(`Scratch kept: ${scratch}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(2);
});
