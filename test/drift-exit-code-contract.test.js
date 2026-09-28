import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-6725 (R4-19): pin the bin/check-provenance-drift exit-code contract in
// one place — 0 clean, 1 drift, 2 usage error. Test-only, no src/bin change.
// Clocks derive from the live fixture snapshot so refreshes never break it.

async function runProbe(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["bin/check-provenance-drift", ...args],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error.code === undefined || typeof error.code !== "number") throw error;
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
  const dir = await mkdtemp(join(tmpdir(), "wayselect-drift-exit-"));
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

test("drift exit code 0: committed fixtures pass clean", async () => {
  const result = await runProbe(["--now", await freshProbeNow()]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /PASS  D1 self-hash/);
  assert.match(result.stdout, /PASS  D2 evidence pin/);
  assert.match(result.stdout, /PASS  D3 freshness/);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).ok, true);
});

test("drift exit code 1: tampered catalog body fails loud", async () => {
  const names = await stageScratch();
  const tampered = JSON.parse(await readFile(names.catalog, "utf8"));
  tampered.catalog.northstar.models["alpha-chat"].cost.input = 999;
  await writeFile(names.catalog, JSON.stringify(tampered, null, 2));

  const result = await runProbe([
    "--catalog",
    names.catalog,
    "--evidence",
    names.evidence,
    "--now",
    await freshProbeNow(),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL  D1 self-hash/);
  assert.match(result.stderr, /ProvenanceDriftError: provenance drift detected/);
});

test("drift exit code 2: unknown flag is a usage error", async () => {
  const result = await runProbe(["--bogus"]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown argument: --bogus/);
  assert.match(result.stderr, /Usage: node bin\/check-provenance-drift/);
});
