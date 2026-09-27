// Tests for TOG-6723 (round-4 gap R4-17): `bin/wayselect --version` falls back
// to `0.0.0` when the manifest is missing or unparseable (test-only).
//
// `readVersion` (bin/wayselect) resolves `../package.json` relative to the
// script file and degrades to `0.0.0` on any read/parse failure or a
// non-string version. These tests pin that fallback by staging an isolated
// copy of the CLI in a temp dir — the real manifest is never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_SOURCE = new URL("../bin/wayselect", import.meta.url);

// Stage an isolated CLI copy: tmp/bin/<script> (real bytes) + symlinked src
// so imports resolve, with a controlled tmp/package.json manifest variant.
// `readVersion` resolves the manifest relative to the staged script path, so
// the real package.json is never read or modified.
//
// The unparseable-manifest case stages the copy as `wayselect.mjs`: Node
// itself refuses to launch an extensionless script next to an unparseable
// package.json (ERR_INVALID_PACKAGE_CONFIG) before the CLI runs, so the
// explicit extension is what lets the CLI's own try/catch fallback execute.
async function stageCli(manifest, scriptName = "wayselect") {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-version-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, scriptName), await readFile(CLI_SOURCE, "utf8"));
  await chmod(join(binDir, scriptName), 0o755);
  await symlink(
    new URL("../src", import.meta.url),
    join(dir, "src"),
  );
  if (manifest !== null) {
    await writeFile(join(dir, "package.json"), manifest);
  }
  return { dir, script: join(dir, "bin", scriptName) };
}

async function runStagedVersion({ dir, script }) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [script, "--version"],
    { cwd: dir },
  );
  return { stdout, stderr };
}

test("missing manifest degrades --version to 0.0.0 with exit 0 (TOG-6723)", async () => {
  const staged = await stageCli(null);
  try {
    const { stdout, stderr } = await runStagedVersion(staged);
    assert.equal(stderr, "");
    assert.equal(stdout, "wayselect 0.0.0\n");
  } finally {
    await rm(staged.dir, { recursive: true, force: true });
  }
});

test("unparseable manifest degrades --version to 0.0.0 with exit 0 (TOG-6723)", async () => {
  const staged = await stageCli("{not valid json", "wayselect.mjs");
  try {
    const { stdout, stderr } = await runStagedVersion(staged);
    assert.equal(stderr, "");
    assert.equal(stdout, "wayselect 0.0.0\n");
  } finally {
    await rm(staged.dir, { recursive: true, force: true });
  }
});

test("manifest without a string version degrades --version to 0.0.0 (TOG-6723)", async () => {
  for (const manifest of ['{"name": "wayselect"}', '{"version": 42}']) {
    const staged = await stageCli(manifest);
    try {
      const { stdout, stderr } = await runStagedVersion(staged);
      assert.equal(stderr, "");
      assert.equal(stdout, "wayselect 0.0.0\n");
    } finally {
      await rm(staged.dir, { recursive: true, force: true });
    }
  }
});
