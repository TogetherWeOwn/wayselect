import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CatalogStaleError,
  requireFreshCatalog,
  selectRoute,
} from "../src/index.js";
import { loadConfiguredCandidates, readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Refresh-proof clock: derived from the live fixture snapshot so provenance
// refreshes never break these tests. Stays inside the 72h evidence window
// (freshest observedAt is 22h behind the snapshot) so the gate under test is
// catalog staleness, not evidence.
async function staleEvaluationTime() {
  const catalog = await readFixture("catalog.synthetic.json");
  return new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + DAY_MS + 1000,
  ).toISOString();
}

// TOG-5117 (leaf of TOG-4791 ingestion slice): an expired catalog snapshot
// must refuse routing, not serve stale data. The fail-closed implementation
// lives in src/freshness.js (checkCatalogFreshness/requireFreshCatalog),
// src/eligibility.js (catalogProbe => stale-catalog/future-catalog), and
// bin/wayselect (catalog + maxCatalogAgeMs wiring). These tests prove the
// routing refusal end to end, including the two assertions missing elsewhere:
// CLI transport stays null (no FakeTransport.send on stale) and the snapshot
// CLI writes no file on stale.
function staleNow(catalog) {
  return new Date(Date.parse(catalog.provenance.snapshotTimestamp) + MAX_CATALOG_AGE_MS + 1000);
}

const staleRequest = Object.freeze({
  operation: "chat",
  requiredCapabilities: ["toolUse"],
  providerAllowlist: ["northstar", "orbit"],
});

function staleOptions(catalog, now) {
  return {
    now,
    maxEvidenceAgeMs: 72 * 60 * 60 * 1000,
    catalog,
    maxCatalogAgeMs: MAX_CATALOG_AGE_MS,
  };
}

test("TOG-5117: expired snapshot refuses routing at the library layer", async () => {
  const { catalog, candidates } = await loadConfiguredCandidates();
  const now = staleNow(catalog);

  const result = selectRoute(candidates, staleRequest, staleOptions(catalog, now));

  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.selected, null);
  assert.ok(result.candidates.length > 0);
  assert.ok(
    result.candidates.every((candidate) => candidate.reasons.includes("stale-catalog")),
  );

  assert.throws(
    () => requireFreshCatalog(catalog, { now, maxCatalogAgeMs: MAX_CATALOG_AGE_MS }),
    (error) => error instanceof CatalogStaleError,
  );
});

async function runDemoStale(extraArgs = []) {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-tog5117-"));
  try {
    const baseRequest = await readFixture("request.synthetic.json");
    await fs.writeFile(
      join(workDir, "request.json"),
      JSON.stringify({ ...baseRequest, evaluationTime: await staleEvaluationTime() }),
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect",
        "--catalog",
        "fixtures/catalog.synthetic.json",
        "--configuration",
        "fixtures/configuration.synthetic.json",
        "--request",
        join(workDir, "request.json"),
        ...extraArgs,
      ],
      { cwd: repoRoot },
    );
    return JSON.parse(stdout);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

test("TOG-5117: expired snapshot serves no route and performs no transport", async () => {
  // Snapshot + 24h limit + 1s => stale; inside the 72h evidence window so the
  // gate under test is catalog staleness, not evidence.
  const result = await runDemoStale();

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.ok(
    result.selection.candidates.every((candidate) =>
      candidate.reasons.includes("stale-catalog"),
    ),
  );
  assert.equal(
    result.transport,
    null,
    "stale snapshot must not invoke FakeTransport or serve stale data",
  );
});

test("TOG-5117: routing CLI honors explicit --max-catalog-age-hours override", async () => {
  // Same stale timestamp (snapshot + 24h1s), but a 48h window keeps the
  // snapshot fresh. Evidence stays inside the 72h window (~46h age), so
  // selection proves the override reaches the catalog gate rather than
  // masking evidence.
  const result = await runDemoStale(["--max-catalog-age-hours", "48"]);

  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
});

test("TOG-5117: routing CLI rejects a non-numeric staleness override", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["bin/wayselect", "--max-catalog-age-hours", "not-a-number"],
      { cwd: repoRoot },
    ),
    /--max-catalog-age-hours must be a non-negative number/,
  );
});

test("TOG-5117: snapshot CLI writes no file for an expired snapshot", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-tog5117-snap-"));
  const outDir = join(base, "out");
  const catalog = await readFixture("catalog.synthetic.json");
  const stale = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + 30 * DAY_MS,
  ).toISOString();
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "bin/wayselect-snapshot",
          "--out",
          outDir,
          "--now",
          stale,
          "--max-catalog-age-hours",
          "24",
        ],
        { cwd: repoRoot },
      ),
      /stale/,
    );
    const remaining = await fs.readdir(outDir).catch(() => []);
    assert.deepEqual(
      remaining.filter((name) => name.endsWith(".json")),
      [],
      "stale snapshot must not write a snapshot file",
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
