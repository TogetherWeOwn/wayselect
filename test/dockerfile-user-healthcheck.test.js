// TOG-8619: pin the Dockerfile non-root user + working healthcheck.
//
// The preview-server image must keep running as the unprivileged `node` user
// (USER node, no USER root/0 anywhere) and must keep a HEALTHCHECK that hits
// the flag-independent liveness path /wayselect-healthz and treats its
// unknown-path 404 as healthy. The last test proves the target is *working*:
// the live server really answers 404 on that path with preview on and off,
// so the healthcheck's `status !== 404 -> fail` predicate passes in both
// modes. Static file assertions only for the Dockerfile; loopback fetches
// for the live-server half (allowed by support/no-network-guard.js).
//
// node:test, zero dependencies. Runs in CI via `npm test` (test/*.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../web/server.js";

const repoRoot = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, repoRoot), "utf8");

function dockerfile() {
  return read("Dockerfile");
}

test("Dockerfile pins the non-root USER node (no root anywhere)", () => {
  const docker = dockerfile();
  const users = [...docker.matchAll(/^USER\s+(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(users.length > 0, "Dockerfile must contain a USER directive");
  for (const user of users) {
    assert.ok(
      user !== "root" && user !== "0",
      `Dockerfile must never switch to root (found USER ${user})`,
    );
  }
  assert.equal(
    users[users.length - 1],
    "node",
    "the effective runtime user (last USER) must be node",
  );
});

test("Dockerfile HEALTHCHECK targets /wayselect-healthz and expects its 404", () => {
  const docker = dockerfile();
  assert.ok(docker.includes("HEALTHCHECK"), "Dockerfile must keep a HEALTHCHECK");
  const healthcheck = docker.slice(docker.indexOf("HEALTHCHECK"));
  assert.ok(
    healthcheck.includes("/wayselect-healthz"),
    "HEALTHCHECK must probe /wayselect-healthz",
  );
  assert.ok(
    healthcheck.includes("404"),
    "HEALTHCHECK must treat the unknown-path 404 as healthy",
  );
});

test("the healthcheck target is working: /wayselect-healthz answers 404 flag on and off", async () => {
  for (const preview of ["1", "0"]) {
    const server = createApp({ WAYSELECT_PREVIEW: preview });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(
        `http://127.0.0.1:${server.address().port}/wayselect-healthz`,
      );
      // Mirror the Dockerfile predicate: status !== 404 means unhealthy.
      assert.equal(
        res.status,
        404,
        `preview=${preview}: HEALTHCHECK probe must see 404 (got ${res.status})`,
      );
      await res.text();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
