import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

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
});

// TOG-4951 HIGH-2: bin/wayselect used to call selectRoute without the
// catalog/maxCatalogAgeMs options, silently skipping the stale/future-catalog
// fail-closed gate. These tests prove the demo path wires the gate: a stale or
// future-dated catalog snapshot must yield no-eligible-route (never a
// selection), while the default request's 24h override keeps the fresh fixture
// green. Catalog provenance.snapshotTimestamp stays valid ISO throughout; only
// evaluationTime moves, and every offset below stays inside the 72h evidence
// window (evidence observedAt 2026-09-23T12Z) so the gate under test is the
// catalog freshness gate, not evidence staleness.
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
  // Catalog snapshot 2026-09-24T10Z + 24h limit => stale after 2026-09-25T10Z.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: "2026-09-25T10:00:01.000Z",
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
    evaluationTime: "2026-09-24T09:59:59.000Z",
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
  // Evidence: evaluationTime minus observedAt (2026-09-23T12Z) = 46h < 72h.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: "2026-09-25T10:00:01.000Z",
    maxCatalogAgeHours: 48,
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
});
