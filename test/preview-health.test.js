// Tests for the TOG-5500 preview health probe (bin/check-preview-health).
//
// The probe starts the real preview server in-process, checks the index and
// detail pages, the search forward contract (skip until that slice lands),
// the purchase-stub invariant, and catalog freshness from the live fixture.
// Refresh-proof clocks: derived from the live fixture snapshot so provenance
// refreshes never break these tests.

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

async function runProbe(extraArgs = []) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/check-preview-health", ...extraArgs],
      { cwd: repoRoot },
    );
    return { exit: 0, stdout };
  } catch (error) {
    return { exit: error.code ?? 1, stdout: String(error.stdout ?? "") };
  }
}

test("fresh index passes every homepage check and exits 0", async () => {
  const { exit, stdout } = await runProbe(["--now", await freshNow()]);
  assert.equal(exit, 0, stdout);
  for (const id of ["H1", "H1b", "H1c", "H2", "H2b", "H3", "H4", "F1"]) {
    assert.match(stdout, new RegExp(`PASS ${id} `), `expected PASS ${id}`);
  }
  assert.match(stdout, /0 fail/, "expected zero failures");
});

test("stale index alerts: F1 fails and the probe exits 1", async () => {
  const { exit, stdout } = await runProbe(["--now", await staleNow()]);
  assert.equal(exit, 1, stdout);
  assert.match(stdout, /FAIL F1 .*STALE snapshot/, "expected STALE alert on F1");
  assert.match(stdout, /1 fail/, "expected exactly one failure");
});

test("future-dated index alerts: F1 fails and the probe exits 1", async () => {
  const { exit, stdout } = await runProbe(["--now", await futureNow()]);
  assert.equal(exit, 1, stdout);
  assert.match(stdout, /FAIL F1 .*FUTURE-DATED snapshot/, "expected FUTURE-DATED alert on F1");
});

test("usage errors exit 2 with usage copy", async () => {
  const { exit } = await runProbe(["--bogus-flag"]);
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
    const { exit, stdout } = await runProbe([
      "--base-url",
      base,
      "--now",
      await freshNow(),
    ]);
    assert.equal(exit, 0, stdout);
    assert.match(stdout, /PASS H1 /, "expected homepage checks against --base-url");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
