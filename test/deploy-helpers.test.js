// Tests for the TOG-7131 deploy helpers:
//   scripts/wait-for-host-mirror.mjs  (mirror-settle bounded delay)
//   scripts/wait-for-staging-health.mjs (GET /healthz settle poll)
//
// Stdlib only. The mirror helper performs no network at all; the health
// helper is exercised against the real in-process preview server on loopback
// (the no-network guard's loopback carve-out), plus failure paths that only
// need connection-refused loopback or usage errors.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../web/server.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const MIRROR_SCRIPT = ["scripts/wait-for-host-mirror.mjs"];
const HEALTH_SCRIPT = ["scripts/wait-for-staging-health.mjs"];
const MERGE_SHA = "4a19b591f0b499f95fd3c78ed3c2ce67a37e6776";

async function runScript(script, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { exit: 0, stdout, stderr };
  } catch (error) {
    return { exit: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

// --- wait-for-host-mirror.mjs ---

test("mirror settle waits the bounded delay and names the merge SHA", async () => {
  const { exit, stdout } = await runScript(MIRROR_SCRIPT, [], {
    MERGE_SHA,
    MIRROR_POLL_SECONDS: "0",
  });
  assert.equal(exit, 0, stdout);
  assert.match(stdout, /4a19b591f0b4/, "names the merge commit being absorbed");
  assert.match(stdout, /MIRROR-SETTLE/, "labels the settle step");
});

test("mirror settle rejects a missing MERGE_SHA (exit 2)", async () => {
  const { exit, stderr } = await runScript(MIRROR_SCRIPT, [], {
    MERGE_SHA: "",
    MIRROR_POLL_SECONDS: "0",
  });
  assert.equal(exit, 2, stderr);
});

test("mirror settle rejects a non-SHA MERGE_SHA (exit 2)", async () => {
  const { exit } = await runScript(MIRROR_SCRIPT, [], {
    MERGE_SHA: "not-a-sha",
    MIRROR_POLL_SECONDS: "0",
  });
  assert.equal(exit, 2, "a truncated or non-hex SHA must be a usage error");
});

test("mirror settle rejects a negative poll delay (exit 2)", async () => {
  const { exit } = await runScript(MIRROR_SCRIPT, [], {
    MERGE_SHA,
    MIRROR_POLL_SECONDS: "-5",
  });
  assert.equal(exit, 2, "a negative delay must be a usage error");
});

// --- wait-for-staging-health.mjs ---

async function listenPreview() {
  const server = createApp({ WAYSELECT_PREVIEW: "1" });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

test("health settle passes when /healthz answers ok", async () => {
  const server = await listenPreview();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { exit, stdout } = await runScript(HEALTH_SCRIPT, [
      "--base-url",
      base,
      "--attempts",
      "3",
      "--interval-seconds",
      "1",
    ]);
    assert.equal(exit, 0, stdout);
    assert.match(stdout, /HEALTHY/, "reports healthy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("health settle fails closed on an unreachable base URL (exit 1)", async () => {
  // Loopback with nothing listening: connection refused, no traffic leaves.
  const { exit, stderr } = await runScript(HEALTH_SCRIPT, [
    "--base-url",
    "http://127.0.0.1:1",
    "--attempts",
    "2",
    "--interval-seconds",
    "1",
    "--timeout-seconds",
    "1",
  ]);
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /TOG-913/, "cites the no-skip-and-pass rule");
});

test("health settle fails closed on a non-ok health body (exit 1)", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "starting" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const { exit } = await runScript(HEALTH_SCRIPT, [
      "--base-url",
      base,
      "--attempts",
      "2",
      "--interval-seconds",
      "1",
    ]);
    assert.equal(exit, 1, "a 200 with a non-ok body must not count as healthy");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("health settle without a base URL is a usage error (exit 2)", async () => {
  const { exit } = await runScript(HEALTH_SCRIPT, [], {
    STAGING_URL: "",
    PRODUCTION_URL: "",
  });
  assert.equal(exit, 2, "a missing base URL must be a usage error, never a pass");
});

test("health settle rejects a zero attempt count (exit 2)", async () => {
  const { exit } = await runScript(HEALTH_SCRIPT, [
    "--base-url",
    "http://127.0.0.1:1",
    "--attempts",
    "0",
  ]);
  assert.equal(exit, 2, "zero attempts must be a usage error");
});
