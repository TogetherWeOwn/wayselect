import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  failOnGapsMessage,
  formatCliFailure,
  futureSnapshotMessage,
  invalidMaxCatalogAgeMessage,
  missingValueMessage,
  staleSnapshotMessage,
  unknownArgumentMessage,
} from "../src/cliErrors.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

// Refresh-proof clocks: derived from the live fixture snapshot so provenance
// refreshes never break these tests. Offsets are whole days, so the rendered
// age is an exact millisecond count and the expected bytes stay literal — a
// wording change in src/cliErrors.js still fails the pin.
async function fixtureSnapshotMs() {
  const fixture = JSON.parse(
    await fs.readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  return Date.parse(fixture.provenance.snapshotTimestamp);
}

async function staleNow() {
  return new Date((await fixtureSnapshotMs()) + 30 * DAY_MS).toISOString();
}

async function futureNow() {
  return new Date((await fixtureSnapshotMs()) - 25 * DAY_MS).toISOString();
}

async function freshNow() {
  return new Date((await fixtureSnapshotMs()) + 2 * 60 * 60 * 1000).toISOString();
}

// TOG-5058: every CLI failure path renders one deterministic line on stderr,
// `<Name>: <message>\n`, with exit code 1 and empty stdout. Copy lives in
// src/cliErrors.js; these tests pin the exact bytes so any wording change is
// an intentional revision, not drift. No model calls, no network.
async function runCli(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function assertFailure(result, exactStderr) {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, exactStderr);
}

test("copy builders return exact strings", () => {
  assert.equal(missingValueMessage("--catalog"), "Missing value for --catalog");
  assert.equal(unknownArgumentMessage("--bogus"), "Unknown argument: --bogus");
  assert.equal(
    invalidMaxCatalogAgeMessage(),
    "--max-catalog-age-hours must be a non-negative number",
  );
  assert.equal(
    staleSnapshotMessage(2599200000, 86400000),
    "refusing stale staging snapshot: age 2599200000ms exceeds limit 86400000ms",
  );
  assert.equal(
    futureSnapshotMessage(-1980000000, 86400000),
    "refusing future-dated staging snapshot: age -1980000000ms exceeds limit 86400000ms",
  );
  assert.equal(
    failOnGapsMessage(5),
    "snapshot reports 5 provenance gap(s); failing on --fail-on-gaps",
  );
  const error = new Error("Unknown argument: --bogus");
  assert.equal(formatCliFailure(error), "Error: Unknown argument: --bogus\n");
});

test("wayselect: missing value renders exact bytes", async () => {
  assertFailure(await runCli("bin/wayselect", ["--catalog"]), "Error: Missing value for --catalog\n");
});

test("wayselect: unknown argument renders exact bytes", async () => {
  assertFailure(await runCli("bin/wayselect", ["--bogus", "x"]), "Error: Unknown argument: --bogus\n");
});

test("wayselect: invalid staleness override renders exact bytes", async () => {
  const expected = "Error: --max-catalog-age-hours must be a non-negative number\n";
  assertFailure(await runCli("bin/wayselect", ["--max-catalog-age-hours", "not-a-number"]), expected);
  assertFailure(await runCli("bin/wayselect", ["--max-catalog-age-hours", "-5"]), expected);
});

test("wayselect: missing catalog file renders exact bytes", async () => {
  const missing = "/nonexistent-wayselect-cli-errors.json";
  assertFailure(
    await runCli("bin/wayselect", ["--catalog", missing]),
    `Error: ENOENT: no such file or directory, open '${missing}'\n`,
  );
});

test("wayselect: invalid catalog JSON renders exact bytes", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    const badPath = join(workDir, "bad.json");
    await fs.writeFile(badPath, "not json");
    let expectedMessage;
    try {
      JSON.parse("not json");
    } catch (error) {
      expectedMessage = error.message;
    }
    assertFailure(
      await runCli("bin/wayselect", ["--catalog", badPath]),
      `SyntaxError: ${expectedMessage}\n`,
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("wayselect: catalog validation failure renders exact bytes", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    // No `catalog` key: normalizeCatalog fails closed before configuration.
    const badPath = join(workDir, "catalog.json");
    await fs.writeFile(badPath, JSON.stringify({ catalog: null }));
    assertFailure(
      await runCli("bin/wayselect", ["--catalog", badPath]),
      "CatalogValidationError: catalog must be an object\n",
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("wayselect: configuration failure renders exact bytes", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    const badPath = join(workDir, "configuration.json");
    await fs.writeFile(
      badPath,
      JSON.stringify({
        candidates: [{ routeId: "nope/nope", supportState: "configured", operations: ["chat"] }],
      }),
    );
    assertFailure(
      await runCli("bin/wayselect", ["--configuration", badPath]),
      "SupportConfigurationError: configuration.candidates[0].routeId is not present in the catalog: nope/nope\n",
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("wayselect: identical input yields identical failure bytes", async () => {
  const first = await runCli("bin/wayselect", ["--bogus", "x"]);
  const second = await runCli("bin/wayselect", ["--bogus", "x"]);
  assert.equal(first.stderr, second.stderr);
  assert.equal(first.stderr, "Error: Unknown argument: --bogus\n");
});

test("wayselect-snapshot: missing value renders exact bytes", async () => {
  assertFailure(
    await runCli("bin/wayselect-snapshot", ["--catalog"]),
    "Error: Missing value for --catalog\n",
  );
});

test("wayselect-snapshot: unknown argument renders exact bytes", async () => {
  assertFailure(
    await runCli("bin/wayselect-snapshot", ["--bogus", "x"]),
    "Error: Unknown argument: --bogus\n",
  );
});

test("wayselect-snapshot: invalid staleness override renders exact bytes", async () => {
  const expected = "Error: --max-catalog-age-hours must be a non-negative number\n";
  assertFailure(
    await runCli("bin/wayselect-snapshot", ["--max-catalog-age-hours", "not-a-number"]),
    expected,
  );
});

test("wayselect-snapshot: stale catalog renders exact bytes and writes no file", async () => {
  const outDir = join(await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-")), "out");
  try {
    assertFailure(
      await runCli("bin/wayselect-snapshot", [
        "--out",
        outDir,
        "--now",
        await staleNow(),
        "--max-catalog-age-hours",
        "24",
      ]),
      "Error: refusing stale staging snapshot: age 2592000000ms exceeds limit 86400000ms\n",
    );
    assert.deepEqual(await fs.readdir(outDir).catch(() => []), []);
  } finally {
    await fs.rm(join(outDir, ".."), { recursive: true, force: true });
  }
});

test("wayselect-snapshot: future-dated catalog renders exact bytes", async () => {
  const outDir = join(await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-")), "out");
  try {
    assertFailure(
      await runCli("bin/wayselect-snapshot", [
        "--out",
        outDir,
        "--now",
        await futureNow(),
        "--max-catalog-age-hours",
        "24",
      ]),
      "Error: refusing future-dated staging snapshot: age -2160000000ms exceeds limit 86400000ms\n",
    );
  } finally {
    await fs.rm(join(outDir, ".."), { recursive: true, force: true });
  }
});

test("wayselect-snapshot: non-staging source renders exact bytes", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    const catalogPath = join(workDir, "catalog.json");
    const fixture = JSON.parse(
      await fs.readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    );
    await fs.writeFile(
      catalogPath,
      JSON.stringify({
        ...fixture,
        provenance: { ...fixture.provenance, source: "https://production.example.invalid/catalog" },
      }),
    );
    assertFailure(
      await runCli("bin/wayselect-snapshot", [
        "--catalog",
        catalogPath,
        "--out",
        join(workDir, "out"),
        "--now",
        "2026-09-24T12:00:00.000Z",
        "--max-catalog-age-hours",
        "24",
      ]),
      'SnapshotError: refusing non-staging catalog source: "https://production.example.invalid/catalog" (staging-only snapshot; expected source prefix "synthetic://")\n',
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test("wayselect-snapshot: --fail-on-gaps renders exact bytes", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    // Green run first to read the live gap count; the failure line then pins
    // the exact bytes for that count.
    const fresh = await freshNow();
    const green = await runCli("bin/wayselect-snapshot", [
      "--out",
      join(base, "green"),
      "--now",
      fresh,
      "--max-catalog-age-hours",
      "24",
    ]);
    const gapCount = JSON.parse(green.stdout).gapCount;
    assert.ok(gapCount > 0);
    assertFailure(
      await runCli("bin/wayselect-snapshot", [
        "--out",
        join(base, "gaps"),
        "--now",
        fresh,
        "--max-catalog-age-hours",
        "24",
        "--fail-on-gaps",
      ]),
      `Error: snapshot reports ${gapCount} provenance gap(s); failing on --fail-on-gaps\n`,
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("wayselect-snapshot: invalid --now renders exact bytes and writes nothing", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"));
  try {
    // Green run first for a valid --previous snapshot, mirroring the
    // --fail-on-gaps test pattern; the bad---now run must fail before any IO.
    const fresh = await freshNow();
    const green = await runCli("bin/wayselect-snapshot", [
      "--out",
      join(base, "green"),
      "--now",
      fresh,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(green.code, 0);
    const previousPath = join(base, "green", JSON.parse(green.stdout).snapshotPath);
    const outDir = join(base, "out");
    const reportPath = join(base, "report.md");
    assertFailure(
      await runCli("bin/wayselect-snapshot", [
        "--out",
        outDir,
        "--now",
        "not-a-date",
        "--max-catalog-age-hours",
        "24",
        "--previous",
        previousPath,
        "--report",
        reportPath,
      ]),
      "CatalogFreshnessError: options.now must be a valid date\n",
    );
    // Fail-before-any-IO: the out dir is never created and no report is written.
    // Assert absence explicitly (not readdir-or-empty): an empty-dir
    // regression must fail this pin.
    await assert.rejects(fs.access(outDir));
    await assert.rejects(fs.access(reportPath));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("wayselect-snapshot: identical input yields identical failure bytes", async () => {
  const args = ["--out", await fs.mkdtemp(join(tmpdir(), "wayselect-cli-errors-"))];
  const stale = await staleNow();
  const first = await runCli("bin/wayselect-snapshot", [
    ...args,
    "--now",
    stale,
    "--max-catalog-age-hours",
    "24",
  ]);
  const second = await runCli("bin/wayselect-snapshot", [
    ...args,
    "--now",
    stale,
    "--max-catalog-age-hours",
    "24",
  ]);
  assert.equal(first.stderr, second.stderr);
  assert.equal(
    first.stderr,
    "Error: refusing stale staging snapshot: age 2592000000ms exceeds limit 86400000ms\n",
  );
});

test("wayselect-snapshot: --help and -h print usage and exit 0 (TOG-7659)", async () => {
  const expected =
    "Usage: node bin/wayselect-snapshot [--catalog <path>] [--out <dir>]\n" +
    "    [--previous <snapshot>] [--report <path>] [--now <ISO>]\n" +
    "    [--max-catalog-age-hours <n>] [--fail-on-gaps]\n";
  for (const flag of ["--help", "-h"]) {
    const result = await runCli("bin/wayselect-snapshot", [flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
});

test("wayselect-search-index-refresh: --help and -h print usage and exit 0 (TOG-7659)", async () => {
  const expected =
    "Usage: node bin/wayselect-search-index-refresh [--catalog <path>]\n" +
    "    [--out <dir>] [--previous <index>] [--now <ISO>]\n" +
    "    [--max-catalog-age-hours <n>] [--check]\n";
  for (const flag of ["--help", "-h"]) {
    const result = await runCli("bin/wayselect-search-index-refresh", [flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, expected);
  }
});
