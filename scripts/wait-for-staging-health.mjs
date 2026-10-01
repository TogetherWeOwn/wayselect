#!/usr/bin/env node

// Health-settle poll for the TOG-6910 deploy jobs
// (.github/workflows/ci.yml: deploy-staging, deploy-production).
//
// A 200 from the Coolify deploy call only QUEUED the deploy. This step polls
// GET <base-url>/healthz (the orchestrator liveness probe, TOG-5726: ungated
// by WAYSELECT_PREVIEW, `{status:"ok"}`) until the new release answers, so a
// green job means "it is live" — fleet precedent: two-web deploy.yml's
// "Wait for staging to answer".
//
// The smoke step that follows still owns content acceptance (listings,
// badges, purchase-stub invariant); this step only proves the new process is
// serving. No skip branch: an unreachable base URL FAILS (TOG-913).
//
// Usage:
//   node scripts/wait-for-staging-health.mjs --base-url <url>
//     [--attempts <n>] [--interval-seconds <n>] [--timeout-seconds <n>]
//
// Env fallback: STAGING_URL (staging job) or PRODUCTION_URL (prod job) when
// --base-url is omitted. Stdlib only.
//
// Exit codes: 0 healthy, 1 never answered, 2 usage error.

import { env, exit } from "node:process";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 10;

function usage() {
  return [
    "Usage: node scripts/wait-for-staging-health.mjs [--base-url <url>]",
    "    [--attempts <n>] [--interval-seconds <n>] [--timeout-seconds <n>]",
    "",
    "  --base-url  public base URL (or set STAGING_URL / PRODUCTION_URL)",
    "  --attempts  max polls (default 60); --interval-seconds between them",
    "              (default 10): ~10 minutes, matching the two-web precedent",
    "  --timeout-seconds  per-request timeout (default 10)",
    "",
    "Polls GET <base-url>/healthz for {status:\"ok\"}. Never skips.",
  ].join("\n");
}

function parseArgs(args) {
  const values = { baseUrl: env.STAGING_URL ?? env.PRODUCTION_URL ?? null };
  let attempts = DEFAULT_ATTEMPTS;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      exit(0);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--base-url") values.baseUrl = value;
    else if (flag === "--attempts") attempts = Number(value);
    else if (flag === "--interval-seconds") intervalSeconds = Number(value);
    else if (flag === "--timeout-seconds") timeoutSeconds = Number(value);
    else throw new Error(`Unknown argument: ${flag}`);
    i += 1;
  }
  if (typeof values.baseUrl !== "string" || values.baseUrl.trim() === "") {
    throw new Error("Missing --base-url (or STAGING_URL / PRODUCTION_URL)");
  }
  for (const [label, n] of [["--attempts", attempts], ["--interval-seconds", intervalSeconds], ["--timeout-seconds", timeoutSeconds]]) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be an integer >= 1`);
  }
  return { baseUrl: values.baseUrl.replace(/\/+$/, ""), attempts, intervalSeconds, timeoutSeconds };
}

async function probeOnce(url, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(`${url}/healthz`, { signal: controller.signal });
    if (res.status !== 200) return false;
    const body = await res.json().catch(() => null);
    return body !== null && body.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`);
    exit(2);
  }
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (await probeOnce(options.baseUrl, options.timeoutSeconds)) {
      process.stdout.write(`HEALTHY: ${options.baseUrl}/healthz answered ok after ${attempt} attempt(s).\n`);
      return;
    }
    if (attempt < options.attempts) await sleep(options.intervalSeconds * 1000);
  }
  process.stderr.write(
    `FAIL health-settle: ${options.baseUrl}/healthz did not answer ok within ` +
      `${options.attempts} attempts. The deploy was queued but the release is not serving; ` +
      `roll back from the Coolify dashboard. Refusing to skip-and-pass (TOG-913).\n`,
  );
  exit(1);
}

main();
