import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// TOG-5747: pin the bin/check-provenance-drift --out JSON report shape so
// scheduler consumers can rely on it. The schema lives at
// schema/drift-report/v1.json; these tests assert the probe's green AND red
// --out reports validate against it with the D1/D2/D3 check table intact.
// Red runs must still write the report (exit 1 carries the FAIL lines, the
// --out file carries the machine-readable verdict).

const schema = JSON.parse(
  await readFile(join(repoRoot, "schema", "drift-report", "v1.json"), "utf8"),
);
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateReport = ajv.compile(schema);

function assertValidReport(report, label) {
  const valid = validateReport(report);
  assert.equal(
    valid,
    true,
    `${label}: report fails schema validation: ` +
      `${JSON.stringify(validateReport.errors ?? [], null, 2).slice(0, 2000)}`,
  );
}

async function runProbeOut(args, { expectExit = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-drift-schema-"));
  const out = join(dir, "drift-report.json");
  let code = 0;
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      ["bin/check-provenance-drift", ...args, "--out", out],
      { cwd: repoRoot },
    ));
  } catch (error) {
    if (error.code === undefined || typeof error.code !== "number") throw error;
    code = error.code;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
  }
  assert.equal(code, expectExit, `probe exited ${code}, expected ${expectExit}: ${(stdout + stderr).slice(0, 500)}`);
  return JSON.parse(await readFile(out, "utf8"));
}

async function freshProbeNow() {
  const catalog = JSON.parse(
    await readFile(join(repoRoot, "fixtures", "catalog.synthetic.json"), "utf8"),
  );
  return new Date(Date.parse(catalog.provenance.snapshotTimestamp) + 2 * 60 * 60 * 1000).toISOString();
}

async function stageScratch() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-drift-schema-"));
  const names = {
    catalog: join(dir, "catalog.json"),
    evidence: join(dir, "evidence.json"),
  };
  await Promise.all([
    writeFile(names.catalog, await readFile(join(repoRoot, "fixtures", "catalog.synthetic.json"), "utf8")),
    writeFile(names.evidence, await readFile(join(repoRoot, "fixture-refresh-evidence.json"), "utf8")),
  ]);
  return names;
}

function assertCheckTable(report) {
  assert.equal(report.checks.length, 3);
  assert.match(report.checks[0].name, /^D1\b/);
  assert.match(report.checks[1].name, /^D2\b/);
  assert.match(report.checks[2].name, /^D3\b/);
}

test("green run: --out report validates, D1/D2/D3 pass, hashes agree", async () => {
  const report = await runProbeOut(["--now", await freshProbeNow()], { expectExit: 0 });
  assertValidReport(report, "green");
  assert.equal(report.ok, true);
  assert.equal(report.mode, "provenance-drift-probe");
  assertCheckTable(report);
  assert.deepEqual(report.checks.map((c) => c.status), ["pass", "pass", "pass"]);
  assert.match(report.recordedHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.recomputedHash, report.recordedHash);
  assert.equal(report.evidenceHash, report.recordedHash);
  assert.equal(report.evidenceVerdict, "PASS");
  assert.equal(report.freshness.fresh, true);
});

test("red run (tampered body): --out still validates, D1+D2 fail, hashes disagree", async () => {
  const names = await stageScratch();
  const tampered = JSON.parse(await readFile(names.catalog, "utf8"));
  tampered.catalog.northstar.models["alpha-chat"].cost.input = 999;
  await writeFile(names.catalog, JSON.stringify(tampered, null, 2));

  const report = await runProbeOut(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assertValidReport(report, "tampered");
  assert.equal(report.ok, false);
  assertCheckTable(report);
  assert.deepEqual(report.checks.map((c) => c.status), ["fail", "fail", "pass"]);
  assert.notEqual(report.recomputedHash, report.recordedHash);
  assert.equal(report.evidenceHash, report.recordedHash);
});

test("red run (stale snapshot): --out still validates, D3 fails fresh:false", async () => {
  const names = await stageScratch();
  const catalog = JSON.parse(await readFile(names.catalog, "utf8"));
  const staleNow = new Date(Date.parse(catalog.provenance.snapshotTimestamp) + 50 * 60 * 60 * 1000).toISOString();

  const report = await runProbeOut(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", staleNow],
    { expectExit: 1 },
  );
  assertValidReport(report, "stale");
  assert.equal(report.ok, false);
  assertCheckTable(report);
  assert.deepEqual(report.checks.map((c) => c.status), ["pass", "pass", "fail"]);
  assert.equal(report.freshness.fresh, false);
  assert.ok(report.freshness.ageMs > report.freshness.maxCatalogAgeMs);
});

test("red run (non-PASS verdict): --out still validates, D2 fails, verdict passes through", async () => {
  const names = await stageScratch();
  await writeFile(names.evidence, JSON.stringify({ verdict: "FAIL" }));

  const report = await runProbeOut(
    ["--catalog", names.catalog, "--evidence", names.evidence, "--now", await freshProbeNow()],
    { expectExit: 1 },
  );
  assertValidReport(report, "bad-verdict");
  assert.equal(report.ok, false);
  assertCheckTable(report);
  assert.deepEqual(report.checks.map((c) => c.status), ["pass", "fail", "pass"]);
  assert.equal(report.evidenceVerdict, "FAIL");
  assert.equal(report.evidenceHash, null);
});
