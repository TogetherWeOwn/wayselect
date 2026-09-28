// Tests for the TOG-5848 staging deploy smoke
// (bin/smoke-wayselect-staging-preview).
//
// The smoke hits the preview health gates (index, detail, 404,
// purchase-stub 403, TOG-5731 security headers) plus the buyer happy path
// (B2–B9 from docs/wayselect-buyer-activation.md) and the file-side
// freshness check. Refresh-proof clocks: derived from the live fixture
// snapshot so provenance refreshes never break these tests.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../web/server.js";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

async function snapshotMs() {
  const catalog = await readFixture("catalog.synthetic.json");
  return Date.parse(catalog.provenance.snapshotTimestamp);
}

async function freshNow() {
  return new Date((await snapshotMs()) + 2 * 60 * 60 * 1000).toISOString();
}

async function staleNow() {
  return new Date((await snapshotMs()) + DAY_MS + 1000).toISOString();
}

async function futureNow() {
  return new Date((await snapshotMs()) - 1000).toISOString();
}

async function runSmoke(extraArgs = [], env = {}) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/smoke-wayselect-staging-preview", ...extraArgs],
      { cwd: repoRoot, env: { ...process.env, ...env } },
    );
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.code ?? 1, stdout: String(error.stdout ?? "") };
  }
}

const HEALTH_IDS = ["H0", "H1", "H1b", "H1c", "H2", "H2b", "H3", "H4", "H5", "H5b", "F1"];
const BUYER_IDS = [
  "B2",
  "B3a",
  "B3b",
  "B3c",
  "B4",
  "B5",
  "B6",
  "B7a",
  "B7b",
  "B7c",
  "B8",
  "B9",
];

test("fresh local run passes health + buyer gates and exits 0", async () => {
  const { exit, stdout } = await runSmoke(["--now", await freshNow()]);
  assert.equal(exit, 0, stdout);
  for (const id of [...HEALTH_IDS, ...BUYER_IDS]) {
    assert.match(stdout, new RegExp(`PASS ${id} `), `expected PASS ${id}`);
  }
  assert.match(stdout, /0 fail/, "expected zero failures");
});

test("stale index alerts: F1 fails and the smoke exits 1", async () => {
  const { exit, stdout } = await runSmoke(["--now", await staleNow()]);
  assert.equal(exit, 1, stdout);
  assert.match(stdout, /FAIL F1 .*STALE snapshot/, "expected STALE alert on F1");
});

test("future-dated index alerts: F1 fails and the smoke exits 1", async () => {
  const { exit, stdout } = await runSmoke(["--now", await futureNow()]);
  assert.equal(exit, 1, stdout);
  assert.match(stdout, /FAIL F1 .*FUTURE-DATED snapshot/, "expected FUTURE-DATED alert on F1");
});

test("usage errors exit 2 with usage copy", async () => {
  const { exit } = await runSmoke(["--bogus-flag"]);
  assert.equal(exit, 2);
});

test("--base-url probes a running server instead of starting one", async () => {
  const server = createApp({ WAYSELECT_PREVIEW: "1" });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { exit, stdout } = await runSmoke(["--base-url", base, "--now", await freshNow()]);
    assert.equal(exit, 0, stdout);
    assert.match(stdout, /TARGET: remote/, "expected remote target line");
    for (const id of ["H1", "B5", "B7b", "F1"]) {
      assert.match(stdout, new RegExp(`PASS ${id} `), `expected PASS ${id}`);
    }
    assert.match(stdout, /SKIP B9/, "expected B9 skip on a remote target");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("WAYSELECT_STAGING_URL is honored without --base-url", async () => {
  const server = createApp({ WAYSELECT_PREVIEW: "1" });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { exit, stdout } = await runSmoke(["--now", await freshNow()], {
      WAYSELECT_STAGING_URL: base,
    });
    assert.equal(exit, 0, stdout);
    assert.match(stdout, /TARGET: remote/, "expected remote target line");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unreachable base URL fails H0 and exits 1", async () => {
  const { exit, stdout } = await runSmoke([
    "--base-url",
    "http://127.0.0.1:1",
    "--now",
    await freshNow(),
  ]);
  assert.equal(exit, 1, stdout);
  assert.match(stdout, /FAIL H0 .*staging preview is reachable/, "expected H0 failure");
});
