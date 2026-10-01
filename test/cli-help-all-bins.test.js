import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-8333: golden pins for `--help` across all four bins. A TOG-7659-class
// regression (a bin exiting non-zero on --help, e.g. `Error: Missing value
// for --help` with exit 1 because --help fell through to a valued-flag
// parser) must fail loudly here. The snapshot/refresh fix itself landed via
// #216 (pinned in test/cli-errors.test.js); this file is the unified
// four-bin contract — wayselect's exit contract (exact global-help bytes
// stay pinned in test/cli-golden.test.js, TOG-6045) plus byte-for-byte pins
// for snapshot, snapshot-prune (not covered by #216) and refresh. No
// fixtures, no network, no writes: --help short-circuits before any catalog
// read.

async function runBin(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const SNAPSHOT_HELP =
  "Usage: node bin/wayselect-snapshot [--catalog <path>] [--out <dir>]\n" +
  "    [--previous <snapshot>] [--report <path>] [--now <ISO>]\n" +
  "    [--max-catalog-age-hours <n>] [--fail-on-gaps]\n";

const PRUNE_HELP =
  "Usage: node bin/wayselect-snapshot-prune [--dir <path>] [--keep-last <n>]\n" +
  "    [--max-age-days <n>] [--now <ISO>] [--apply]\n";

const REFRESH_HELP =
  "Usage: node bin/wayselect-search-index-refresh [--catalog <path>]\n" +
  "    [--out <dir>] [--previous <index>] [--now <ISO>]\n" +
  "    [--max-catalog-age-hours <n>] [--check]\n";

test("golden: wayselect --help exits 0 with empty stderr", async () => {
  const result = await runBin("bin/wayselect", ["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^wayselect — /);
});

test("golden: wayselect-snapshot --help pins exact bytes", async () => {
  const result = await runBin("bin/wayselect-snapshot", ["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, SNAPSHOT_HELP);
});

test("golden: wayselect-snapshot-prune --help pins exact bytes", async () => {
  const result = await runBin("bin/wayselect-snapshot-prune", ["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, PRUNE_HELP);
});

test("golden: wayselect-search-index-refresh --help pins exact bytes", async () => {
  const result = await runBin("bin/wayselect-search-index-refresh", ["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, REFRESH_HELP);
});

test("golden: -h matches --help on the three utility bins", async () => {
  for (const [bin, expected] of [
    ["bin/wayselect-snapshot", SNAPSHOT_HELP],
    ["bin/wayselect-snapshot-prune", PRUNE_HELP],
    ["bin/wayselect-search-index-refresh", REFRESH_HELP],
  ]) {
    const result = await runBin(bin, ["-h"]);
    assert.equal(result.code, 0, `${bin} -h must exit 0`);
    assert.equal(result.stderr, "", `${bin} -h must keep stderr empty`);
    assert.equal(result.stdout, expected, `${bin} -h must match --help bytes`);
  }
});
