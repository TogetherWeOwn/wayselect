#!/usr/bin/env node

// Deploy-target gate for the TOG-6910 deploy jobs
// (.github/workflows/ci.yml: deploy-staging, deploy-production).
//
// Exits 0 when the named hook + URL env vars are both present and non-blank,
// exits 1 otherwise. A missing deploy target FAILS the job — this gate must
// never gain a "skip and pass" branch (TOG-913: a control that reports success
// for work it did not do produces false "it shipped" claims).
//
// Secret hygiene: only env var NAMES are ever printed, never values. The hook
// URL carries its token, so it is passed to later steps via the secrets
// context directly, never through this script's output.
//
// Usage:
//   node scripts/check-deploy-target.mjs --env-name staging \
//     --hook-env COOLIFY_STAGING_DEPLOY_HOOK --url-env WAYSELECT_STAGING_URL
//
// Exit codes: 0 ready, 1 missing target, 2 usage error. Stdlib only.

import { argv, env, exit } from "node:process";

function usage() {
  return [
    "Usage: node scripts/check-deploy-target.mjs --env-name <name>",
    "    --hook-env <VAR> --url-env <VAR>",
    "",
    "  --env-name  deployment environment label for log lines (e.g. staging)",
    "  --hook-env  env var holding the Coolify deploy-hook URL",
    "  --url-env   env var holding the public base URL of the deployment",
    "",
    "Only variable NAMES are printed, never values.",
  ].join("\n");
}

function parseArgs(args) {
  const values = { envName: null, hookEnv: null, urlEnv: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      exit(0);
    }
    const value = args[i + 1];
    if (flag === "--env-name" || flag === "--hook-env" || flag === "--url-env") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--env-name") values.envName = value;
      else if (flag === "--hook-env") values.hookEnv = value;
      else values.urlEnv = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  for (const key of ["envName", "hookEnv", "urlEnv"]) {
    if (values[key] === null) throw new Error(`Missing required --${key.replace(/Env$/, "-env").toLowerCase()}`);
  }
  return values;
}

function main() {
  let args;
  try {
    args = parseArgs(argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`);
    exit(2);
  }

  const missing = [];
  for (const name of [args.hookEnv, args.urlEnv]) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") missing.push(name);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `FAIL deploy-target (${args.envName}): missing ${missing.join(", ")} — ` +
        `no deploy target is provisioned. Wire the Coolify hook + public URL, then re-run. ` +
        `Refusing to skip-and-pass (TOG-913; see TOG-6910).\n`,
    );
    exit(1);
  }

  process.stdout.write(
    `READY deploy-target (${args.envName}): hook (${args.hookEnv}) and URL (${args.urlEnv}) present; values redacted.\n`,
  );
}

main();
