import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-8617: --version golden pins for all four bins. Distinct from the
// TOG-8333 --help golden (no shared file): these tests assert exact
// --version stdout bytes (exit 0, empty stderr) so editing any version
// string or program name fails the suite intentionally. Test-only: the
// bin implementations were edited on a prior run of this card.

async function runBin(bin, args) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [`bin/${bin}`, ...args],
    { cwd: repoRoot },
  );
  return { stdout, stderr };
}

test("golden: wayselect --version pins exact bytes", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout, stderr } = await runBin("wayselect", ["--version"]);
  assert.equal(stderr, "");
  assert.equal(stdout, `wayselect ${pkg.version}\n`);
  assert.match(stdout, /^wayselect \d+\.\d+\.\d+\n$/);
});

test("golden: wayselect-snapshot --version pins exact bytes", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout, stderr } = await runBin("wayselect-snapshot", ["--version"]);
  assert.equal(stderr, "");
  assert.equal(stdout, `wayselect-snapshot ${pkg.version}\n`);
  assert.match(stdout, /^wayselect-snapshot \d+\.\d+\.\d+\n$/);
});

test("golden: wayselect-snapshot-prune --version pins exact bytes", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout, stderr } = await runBin("wayselect-snapshot-prune", [
    "--version",
  ]);
  assert.equal(stderr, "");
  assert.equal(stdout, `wayselect-snapshot-prune ${pkg.version}\n`);
  assert.match(stdout, /^wayselect-snapshot-prune \d+\.\d+\.\d+\n$/);
});

test("golden: wayselect-search-index-refresh --version pins exact bytes", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout, stderr } = await runBin("wayselect-search-index-refresh", [
    "--version",
  ]);
  assert.equal(stderr, "");
  assert.equal(stdout, `wayselect-search-index-refresh ${pkg.version}\n`);
  assert.match(stdout, /^wayselect-search-index-refresh \d+\.\d+\.\d+\n$/);
});
