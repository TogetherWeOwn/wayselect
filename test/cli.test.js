import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

// Refresh-proof clocks: derived from the live fixture snapshot so provenance
// refreshes never break these tests. Every offset below stays inside the 72h
// evidence window (freshest observedAt is 22h behind the snapshot) so the gate
// under test is the catalog freshness gate, not evidence staleness.
async function snapshotMs() {
  const catalog = await readFixture("catalog.synthetic.json");
  return Date.parse(catalog.provenance.snapshotTimestamp);
}

async function staleEvaluationTime() {
  return new Date((await snapshotMs()) + DAY_MS + 1000).toISOString();
}

async function futureEvaluationTime() {
  return new Date((await snapshotMs()) - 1000).toISOString();
}

test("fixture CLI demonstrates catalog to explanation with fake transport", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wayselect"],
    { cwd: new URL("..", import.meta.url) },
  );
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.earlyDevelopment, true);
  assert.equal(result.mode, "dry-run-only");
  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
  assert.equal(result.transport.adapter, "fake");
  assert.equal(result.transport.networkUsed, false);
  assert.equal(
    result.provenance.snapshotHash,
    "sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d",
  );
});

async function writeTempJson(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

test("CLI denies a tampered catalog body without selecting a route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-tamper-"));
  const [catalogRaw, configuration, request] = await Promise.all([
    readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/configuration.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/request.synthetic.json", import.meta.url), "utf8"),
  ]);
  const catalogFixture = JSON.parse(catalogRaw);
  catalogFixture.catalog.northstar.models["alpha-chat"].tool_call = false;

  const catalogPath = await writeTempJson(dir, "catalog.json", catalogFixture);
  const configurationPath = await writeTempJson(dir, "configuration.json", JSON.parse(configuration));
  const requestPath = await writeTempJson(dir, "request.json", JSON.parse(request));

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "bin/wayselect",
          "--catalog",
          catalogPath,
          "--configuration",
          configurationPath,
          "--request",
          requestPath,
        ],
        { cwd: repoRoot },
      ),
    /CatalogIntegrityError: catalog body does not match provenance.snapshotHash/,
  );
});

test("CLI fails closed with stale-catalog when the feed exceeds maxCatalogAgeHours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-stale-"));
  const [catalogRaw, configuration, requestRaw] = await Promise.all([
    readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/configuration.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/request.synthetic.json", import.meta.url), "utf8"),
  ]);
  const staleRequest = JSON.parse(requestRaw);
  const catalogFixture = JSON.parse(catalogRaw);
  staleRequest.evaluationTime = new Date(
    Date.parse(catalogFixture.provenance.snapshotTimestamp) + 4 * DAY_MS,
  ).toISOString();

  const catalogPath = await writeTempJson(dir, "catalog.json", JSON.parse(catalogRaw));
  const configurationPath = await writeTempJson(dir, "configuration.json", JSON.parse(configuration));
  const requestPath = await writeTempJson(dir, "request.json", staleRequest);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "bin/wayselect",
      "--catalog",
      catalogPath,
      "--configuration",
      configurationPath,
      "--request",
      requestPath,
    ],
    { cwd: repoRoot },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.equal(result.transport, null);
  assert.ok(result.selection.candidates.length > 0);
  assert.ok(
    result.selection.candidates.every(
      (candidate) =>
        candidate.eligible === false && candidate.reasons.includes("stale-catalog"),
    ),
  );
});

// TOG-4951 HIGH-2: bin/wayselect used to call selectRoute without the
// catalog/maxCatalogAgeMs options, silently skipping the stale/future-catalog
// fail-closed gate. These tests prove the demo path wires the gate: a stale or
// future-dated catalog snapshot must yield no-eligible-route (never a
// selection), while the default request's 24h override keeps the fresh fixture
// green. Catalog provenance.snapshotTimestamp stays valid ISO throughout; only
// evaluationTime moves, and every offset below (derived from the live
// snapshot) stays inside the 72h evidence window (freshest observedAt is 22h
// behind the snapshot) so the gate under test is the catalog freshness gate,
// not evidence staleness.
async function runDemoWithRequest(requestOverrides = {}, catalogOverrides = {}) {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-"));
  try {
    const baseRequest = await readFixture("request.synthetic.json");
    await fs.writeFile(
      join(workDir, "request.json"),
      JSON.stringify({ ...baseRequest, ...requestOverrides }),
    );
    let catalogPath = "fixtures/catalog.synthetic.json";
    if (Object.keys(catalogOverrides).length > 0) {
      const baseCatalog = await readFixture("catalog.synthetic.json");
      await fs.writeFile(
        join(workDir, "catalog.json"),
        JSON.stringify({
          ...baseCatalog,
          provenance: { ...baseCatalog.provenance, ...catalogOverrides },
        }),
      );
      catalogPath = join(workDir, "catalog.json");
    }
    return await execFileAsync(
      process.execPath,
      [
        "bin/wayselect",
        "--catalog",
        catalogPath,
        "--configuration",
        "fixtures/configuration.synthetic.json",
        "--request",
        join(workDir, "request.json"),
      ],
      { cwd: repoRoot },
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

test("fixture CLI wires the catalog gate: stale snapshot selects no route", async () => {
  // Snapshot + 24h limit + 1s => stale; inside the 72h evidence window.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await staleEvaluationTime(),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.ok(result.selection.candidates.length > 0);
  assert.ok(
    result.selection.candidates.every((candidate) =>
      candidate.reasons.includes("stale-catalog"),
    ),
  );
});

test("fixture CLI wires the catalog gate: future snapshot selects no route", async () => {
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await futureEvaluationTime(),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.ok(
    result.selection.candidates.every((candidate) =>
      candidate.reasons.includes("future-catalog"),
    ),
  );
});

test("fixture CLI honors an explicit wider maxCatalogAgeHours override", async () => {
  // Same stale timestamp as above, but a 48h window keeps the snapshot fresh.
  // Evidence: evaluationTime (snapshot + 24h1s) minus freshest observedAt
  // (snapshot - 22h) = ~46h < 72h.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await staleEvaluationTime(),
    maxCatalogAgeHours: 48,
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
});
