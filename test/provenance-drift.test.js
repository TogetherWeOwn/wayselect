import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  computeCatalogSnapshotHash,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-5542: provenance-drift detector probe. Independent leaf beside the
// TOG-5116 harness: read-only checks against the COMMITTED fixtures, never
// a refresh, never a write. Clocks derive from the live snapshot so these
// tests stay valid across real refreshes.

async function runProbe(args, { expectExit } = {}) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["bin/check-provenance-drift", ...args],
      { cwd: repoRoot },
    );
    if (expectExit !== undefined && expectExit !== 0) {
      throw new Error(`probe exited 0, expected ${expectExit}: ${stdout.slice(0, 300)}`);
    }
    return { code: 0, stdout };
  } catch (error) {
    if (error.code === undefined || typeof error.code !== "number") throw error;
    if (expectExit !== undefined && error.code !== expectExit) {
      throw new Error(
        `probe exited ${error.code}, expected ${expectExit}: ` +
          `${(error.stdout ?? "").slice(0, 300)}${(error.stderr ?? "").slice(0, 300)}`,
      );
    }
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function freshProbeNow() {
  const catalog = JSON.parse(
    await readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  return new Date(Date.parse(catalog.provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000).toISOString();
}

async function stageScratch() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-drift-"));
  const names = {
    catalog: join(dir, "catalog.json"),
    evidence: join(dir, "evidence.json"),
  };
  await Promise.all([
    writeFile(
      names.catalog,
      await readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    ),
    writeFile(
      names.evidence,
      await readFile(new URL("../fixture-refresh-evidence.json", import.meta.url), "utf8"),
    ),
  ]);
  return names;
}

test("probe passes on the committed fixtures (3/3, exit 0)", async () => {
  const now = await freshProbeNow();
  const { code, stdout } = await runProbe(["--now", now], { expectExit: 0 });
  assert.equal(code, 0);
  assert.match(stdout, /PASS  D1 self-hash/);
  assert.match(stdout, /PASS  D2 evidence pin/);
  assert.match(stdout, /PASS  D3 freshness/);
  const tail = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(tail.ok, true);
  assert.match(tail.snapshotHash, /^sha256:[a-f0-9]{64}$/);
});

test("probe is read-only: fixture and evidence bytes untouched", async () => {
  const catalogPath = new URL("../fixtures/catalog.synthetic.json", import.meta.url);
  const evidencePath = new URL("../fixture-refresh-evidence.json", import.meta.url);
  const before = {
    catalog: await readFile(catalogPath, "utf8"),
    evidence: await readFile(evidencePath, "utf8"),
  };
  await runProbe(["--now", await freshProbeNow()], { expectExit: 0 });
  await runProbe(["--now", await freshProbeNow(), "--out", join(await mkdtemp(join(tmpdir(), "drift-out-")), "r.json")], { expectExit: 0 });
  assert.equal(await readFile(catalogPath, "utf8"), before.catalog);
  assert.equal(await readFile(evidencePath, "utf8"), before.evidence);
});

test("probe fails loud on a tampered catalog body (D1+D2, exit 1)", async () => {
  const names = await stageScratch();
  const tampered = JSON.parse(await readFile(names.catalog, "utf8"));
  tampered.catalog.northstar.models["alpha-chat"].cost.input = 999;
  await writeFile(names.catalog, JSON.stringify(tampered, null, 2));

  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /FAIL  D1 self-hash/);
  assert.match(result.stdout, /FAIL  D2 evidence pin/);
  assert.match(result.stderr, /ProvenanceDriftError: provenance drift detected \(D1 self-hash, D2 evidence pin\)/);
});

test("probe fails loud on an unknown field even with a re-pinned hash (D1 boundary, exit 1)", async () => {
  const names = await stageScratch();
  const edited = JSON.parse(await readFile(names.catalog, "utf8"));
  edited.catalog.northstar.models["alpha-chat"].endpoint = "https://example.invalid/x";
  edited.provenance.snapshotHash = computeCatalogSnapshotHash(edited.catalog);
  await writeFile(names.catalog, JSON.stringify(edited, null, 2));

  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /FAIL  D1 self-hash/);
  assert.match(result.stdout, /unknown field: endpoint/);
});

test("probe fails loud on a stale snapshot (D3, exit 1)", async () => {
  const names = await stageScratch();
  const catalog = JSON.parse(await readFile(names.catalog, "utf8"));
  const staleNow = new Date(Date.parse(catalog.provenance.snapshotTimestamp) + 50 * 60 * 60 * 1000).toISOString();
  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", staleNow],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /FAIL  D3 freshness/);
  assert.match(result.stdout, /is stale/);
  assert.match(result.stderr, /ProvenanceDriftError: provenance drift detected \(D3 freshness\)/);
});

test("probe fails loud on a future-dated snapshot (D3, exit 1)", async () => {
  const names = await stageScratch();
  const catalog = JSON.parse(await readFile(names.catalog, "utf8"));
  const earlyNow = new Date(Date.parse(catalog.provenance.snapshotTimestamp) - 1000).toISOString();
  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", earlyNow],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /FAIL  D3 freshness/);
  assert.match(result.stdout, /future/);
});

test("probe fails loud when the evidence hash no longer pins the body (D2, exit 1)", async () => {
  const names = await stageScratch();
  const evidence = JSON.parse(await readFile(names.evidence, "utf8"));
  evidence.provenanceHash = `sha256:${"0".repeat(64)}`;
  await writeFile(names.evidence, JSON.stringify(evidence, null, 2));

  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /PASS  D1 self-hash/);
  assert.match(result.stdout, /FAIL  D2 evidence pin/);
  assert.match(result.stdout, /provenance drift: live body recomputes to/);
});

test("probe fails loud on a non-PASS evidence verdict (D2, exit 1)", async () => {
  const names = await stageScratch();
  await writeFile(names.evidence, JSON.stringify({ verdict: "FAIL" }));

  const result = await runProbe(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assert.match(result.stdout, /FAIL  D2 evidence pin/);
  assert.match(result.stdout, /expected "PASS"/);
});

test("probe rejects usage errors with exit 2", async () => {
  const result = await runProbe(["--bogus"], { expectExit: 2 });
  assert.match(result.stderr, /Unknown argument: --bogus/);
});

test("probe --out writes the JSON drift report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-drift-out-"));
  const out = join(dir, "drift-report.json");
  await runProbe(["--now", await freshProbeNow(), "--out", out], { expectExit: 0 });
  const report = JSON.parse(await readFile(out, "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.mode, "provenance-drift-probe");
  assert.equal(report.issue, "TOG-5542");
  assert.equal(report.checks.length, 3);
  assert.deepEqual(report.checks.map((c) => c.status), ["pass", "pass", "pass"]);
  assert.match(report.recordedHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.recomputedHash, report.recordedHash);
  assert.equal(report.evidenceHash, report.recordedHash);
  assert.equal(report.evidenceVerdict, "PASS");
});
