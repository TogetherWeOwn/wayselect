#!/usr/bin/env node

// Mirror-settle wait for the TOG-6910 deploy jobs
// (.github/workflows/ci.yml: deploy-staging, deploy-production).
//
// Coolify clones the HOST mirror (git@<host>:/srv/git/wayselect.git), never
// github.com — the box cannot clone from GitHub (fleet precedent: two-bot
// DEPLOY.md §2, TOG-1175). The box re-mirrors GitHub roughly every 2 minutes,
// so triggering a deploy the instant main moves rebuilds the PREVIOUS commit
// and looks like the merge did nothing (two-bot DEPLOY.md §6.1).
//
// Runners have no SSH to the box, so there is nothing to poll: this step is a
// bounded delay equal to the mirror interval, then exit 0. MERGE_SHA is
// required so the deploy log records exactly which commit the mirror was
// given time to absorb — when a deploy serves stale code, that line tells
// the operator whether the mirror lagged or the trigger did.
//
// Env:
//   MERGE_SHA            merged commit the deploy must contain (40-hex SHA)
//   MIRROR_POLL_SECONDS  settle delay; default 150 (just over one interval)
//
// Exit codes: 0 after the delay elapses, 2 usage error. Stdlib only, and no
// network: nothing here touches the panel or the mirror.

import { env, exit } from "node:process";

const DEFAULT_POLL_SECONDS = 150;

function failUsage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: MERGE_SHA=<40-hex-sha> [MIRROR_POLL_SECONDS=<n>] node scripts/wait-for-host-mirror.mjs\n",
  );
  exit(2);
}

function main() {
  const sha = (env.MERGE_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    failUsage(`Invalid MERGE_SHA ${JSON.stringify(env.MERGE_SHA ?? "")}: expected a 40-hex commit SHA`);
  }

  const raw = (env.MIRROR_POLL_SECONDS ?? String(DEFAULT_POLL_SECONDS)).trim();
  const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(seconds) || seconds < 0) {
    failUsage(`Invalid MIRROR_POLL_SECONDS ${JSON.stringify(env.MIRROR_POLL_SECONDS ?? "")}: expected an integer >= 0`);
  }

  process.stdout.write(
    `MIRROR-SETTLE: waiting ${seconds}s for the host mirror to absorb ${sha.slice(0, 12)} ` +
      `(Coolify clones the mirror, not github.com; runners cannot poll it, so this is a bounded delay).\n`,
  );
  setTimeout(() => {
    process.stdout.write(`MIRROR-SETTLE: elapsed; mirror interval covered for ${sha.slice(0, 12)}.\n`);
  }, seconds * 1000);
}

main();
