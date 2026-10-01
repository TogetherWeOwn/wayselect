#!/usr/bin/env node

// Deploy-target gate for the TOG-6910 deploy jobs
// (.github/workflows/ci.yml: deploy-staging, deploy-production).
//
// Exits 0 when every named env var is present and non-blank, exits 1
// otherwise. A missing deploy target FAILS the job — this gate must never
// gain a "skip and pass" branch (TOG-913: a control that reports success
// for work it did not do produces false "it shipped" claims).
//
// Transport model (TOG-7131): the deploy trigger is host-mediated. Coolify
// rebuilds from the host mirror (/srv/git/wayselect.git) via mirror
// autodeploy, and the panel bearer lives host-side under operator control
// (TOG-7094) — GitHub holds no panel credential and sends no bearer, so the
// public ubuntu-latest runners never move a credential across the public
// internet. The GitHub job owns the Deployment record (via `environment:`),
// the mirror-settle delay, the /healthz settle poll, and the post-deploy
// smoke — so the gate checks the public base URL (--url-env) plus any extra
// identifiers (--require-env). A broad bearer is never embedded in a URL
// and never printed.
//
// Secret hygiene: only env var NAMES are ever printed, never values.
//
// Usage:
//   node scripts/check-deploy-target.mjs --env-name staging \
//     --url-env WAYSELECT_STAGING_URL
//
// Exit codes: 0 ready, 1 missing target, 2 usage error. Stdlib only.

import { argv, env, exit } from "node:process";

function usage() {
  return [
    "Usage: node scripts/check-deploy-target.mjs --env-name <name>",
    "    --url-env <VAR> [--require-env <VAR> ...]",
    "",
    "  --env-name     deployment environment label for log lines (e.g. staging)",
    "  --url-env      env var holding the public base URL of the deployment",
    "  --require-env  extra env var that must be present (repeatable)",
    "",
    "Only variable NAMES are printed, never values.",
  ].join("\n");
}

function parseArgs(args) {
  const values = { envName: null, urlEnv: null, requireEnv: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      exit(0);
    }
    const value = args[i + 1];
    if (flag === "--env-name" || flag === "--url-env" || flag === "--require-env") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${flag}`);
      }
      if (flag === "--env-name") values.envName = value;
      else if (flag === "--url-env") values.urlEnv = value;
      else values.requireEnv.push(value);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  for (const key of ["envName", "urlEnv"]) {
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
  for (const name of [args.urlEnv, ...args.requireEnv]) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") missing.push(name);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `FAIL deploy-target (${args.envName}): missing ${missing.join(", ")} — ` +
        `no deploy target is provisioned. Wire the public URL, then re-run. ` +
        `Refusing to skip-and-pass (TOG-913; see TOG-6910).\n`,
    );
    exit(1);
  }

  const names = [args.urlEnv, ...args.requireEnv].join(", ");
  process.stdout.write(
    `READY deploy-target (${args.envName}): ${names} present; values redacted.\n`,
  );
}

main();
