// TOG-6730: corrupt/truncated search-index `--previous` file behavior pin
// (test-only).
//
// Scope note: the preview HTTP server never loads search-index files from
// disk — it serves the hardcoded `STUB_LISTINGS` slice (`web/stub-listing.js`)
// and reads only `package.json` for the version probe (`web/server.js`). The
// only surface that consumes a search-index file is the refresh CLI's
// `--previous` comparison path (`bin/wayselect-search-index-refresh` ->
// `reloadSearchIndex` in `src/searchIndex.js`). This file pins that path's
// exact fail-closed contract:
//
//   - A corrupt `--previous` file fails closed: exit 1, empty stdout, the
//     failure on stderr, and NO index file or output directory written. The
//     fresh rebuild from the fixture catalog still succeeds on its own, so
//     recovery is "delete the corrupt file and rerun" (rebuild-from-fixture).
//   - Library `reloadSearchIndex` rejects every corrupt shape with an exact
//     `SearchIndexError` message; it never returns a partial index.
//   - Unparseable bytes surface as `SyntaxError` (V8 message text is
//     engine-version dependent, so only the `SyntaxError: ` prefix is pinned;
//     our own `SearchIndexError` strings are pinned byte-exact).
//   - A missing `--previous` path fails closed as `Error: ENOENT` (prefix
//     pinned; the absolute path in the message is environment-dependent).

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  SearchIndexError,
  buildSearchIndex,
  reloadSearchIndex,
} from "../src/searchIndex.js";
import { evaluationNow, readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const NOW = evaluationNow().toISOString();
const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;

async function fixtureParts() {
  const fixture = await readFixture("catalog.synthetic.json");
  return { catalog: fixture.catalog, provenance: fixture.provenance };
}

function refreshOptions() {
  return { now: NOW, maxCatalogAgeMs: MAX_CATALOG_AGE_MS };
}

async function runRefresh(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function pathExists(path) {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

test("TOG-6730: reloadSearchIndex rejects non-object previous indexes", async () => {
  const { catalog, provenance } = await fixtureParts();
  for (const previous of [null, "wayselect-search-index", 42, ["entries"]]) {
    assert.throws(
      () => reloadSearchIndex(previous, catalog, provenance, refreshOptions()),
      (error) =>
        error instanceof SearchIndexError &&
        error.message === "previousIndex must be a search index object",
      `previous=${JSON.stringify(previous)}`,
    );
  }
});

test("TOG-6730: reloadSearchIndex rejects wrong-tool previous indexes", async () => {
  const { catalog, provenance } = await fixtureParts();
  assert.throws(
    () =>
      reloadSearchIndex(
        { tool: "wrong-tool", entries: [{ routeId: "x" }], contentHash: "sha256:abc" },
        catalog,
        provenance,
        refreshOptions(),
      ),
    (error) =>
      error instanceof SearchIndexError &&
      error.message === 'previousIndex.tool: expected "wayselect-search-index", got "wrong-tool"',
  );
});

test("TOG-6730: reloadSearchIndex rejects empty/missing entries", async () => {
  const { catalog, provenance } = await fixtureParts();
  for (const previous of [
    { tool: "wayselect-search-index", entries: [], contentHash: "sha256:abc" },
    { tool: "wayselect-search-index", contentHash: "sha256:abc" },
  ]) {
    assert.throws(
      () => reloadSearchIndex(previous, catalog, provenance, refreshOptions()),
      (error) =>
        error instanceof SearchIndexError &&
        error.message === "previousIndex.entries must be a non-empty array",
      JSON.stringify(Object.keys(previous)),
    );
  }
});

test("TOG-6730: reloadSearchIndex rejects missing/empty contentHash", async () => {
  const { catalog, provenance } = await fixtureParts();
  for (const previous of [
    { tool: "wayselect-search-index", entries: [{ routeId: "x" }] },
    { tool: "wayselect-search-index", entries: [{ routeId: "x" }], contentHash: "" },
  ]) {
    assert.throws(
      () => reloadSearchIndex(previous, catalog, provenance, refreshOptions()),
      (error) =>
        error instanceof SearchIndexError &&
        error.message === "previousIndex.contentHash must be a non-empty string",
      JSON.stringify(Object.keys(previous)),
    );
  }
});

test("TOG-6730: corrupt previous never poisons the fixture rebuild", async () => {
  const { catalog, provenance } = await fixtureParts();
  const options = refreshOptions();
  assert.throws(
    () =>
      reloadSearchIndex(
        { tool: "wrong-tool", entries: [{ routeId: "x" }], contentHash: "sha256:abc" },
        catalog,
        provenance,
        options,
      ),
    SearchIndexError,
  );
  // Rebuild-from-fixture is unaffected by the rejected file: same input still
  // yields the full 6-route index.
  const rebuilt = buildSearchIndex(catalog, provenance, options);
  assert.equal(rebuilt.entries.length, 6);
  assert.match(rebuilt.contentHash, /^sha256:[a-f0-9]{64}$/);
});

test("CLI rejects --check with --previous regardless of file contents or flag order", async () => {
  const base = await fs.mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "wayselect-check-previous-"),
  );
  try {
    const { catalog, provenance } = await fixtureParts();
    const valid = join(base, "valid.json");
    const corrupt = join(base, "corrupt.json");
    await fs.writeFile(valid, JSON.stringify(buildSearchIndex(catalog, provenance, refreshOptions())));
    await fs.writeFile(corrupt, "not json {{{");
    const outDir = join(base, "out");
    for (const previous of [valid, corrupt, join(base, "missing.json"), ""]) {
      for (const flags of [
        ["--check", "--previous", previous],
        ["--previous", previous, "--check"],
      ]) {
        const result = await runRefresh([
          "bin/wayselect-search-index-refresh",
          ...flags,
          "--out",
          outDir,
          "--max-catalog-age-hours",
          "24",
        ]);
        assert.equal(result.code, 1, JSON.stringify(flags));
        assert.equal(result.stdout, "");
        assert.equal(
          result.stderr,
          "Error: --previous cannot be used with --check; omit --check to compare a previous index\n",
        );
        assert.equal(await pathExists(outDir), false);
      }
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("CLI rejects --check with --previous before loading the catalog", async () => {
  const result = await runRefresh([
    "bin/wayselect-search-index-refresh",
    "--check",
    "--previous",
    "missing-previous.json",
    "--catalog",
    "missing-catalog.json",
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Error: --previous cannot be used with --check; omit --check to compare a previous index\n",
  );
});

test("TOG-6730: CLI fails closed on non-JSON --previous bytes", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-corrupt-index-"));
  try {
    const previous = join(base, "corrupt.json");
    await fs.writeFile(previous, "not json at all {{{");
    const outDir = join(base, "out");
    const result = await runRefresh([
      "bin/wayselect-search-index-refresh",
      "--previous",
      previous,
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.ok(
      result.stderr.startsWith("SyntaxError: "),
      `expected SyntaxError prefix, got: ${JSON.stringify(result.stderr)}`,
    );
    assert.equal(await pathExists(outDir), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("TOG-6730: CLI fails closed on truncated JSON --previous bytes", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-corrupt-index-"));
  try {
    const previous = join(base, "truncated.json");
    await fs.writeFile(previous, '{"tool":"wayselect-search-index", "entri');
    const outDir = join(base, "out");
    const result = await runRefresh([
      "bin/wayselect-search-index-refresh",
      "--previous",
      previous,
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.ok(
      result.stderr.startsWith("SyntaxError: "),
      `expected SyntaxError prefix, got: ${JSON.stringify(result.stderr)}`,
    );
    assert.equal(await pathExists(outDir), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("TOG-6730: CLI fails closed on wrong-tool --previous file", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-corrupt-index-"));
  try {
    const previous = join(base, "wrong-tool.json");
    await fs.writeFile(
      previous,
      JSON.stringify({ tool: "wrong-tool", entries: [{ routeId: "x" }], contentHash: "sha256:abc" }),
    );
    const outDir = join(base, "out");
    const result = await runRefresh([
      "bin/wayselect-search-index-refresh",
      "--previous",
      previous,
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      'SearchIndexError: previousIndex.tool: expected "wayselect-search-index", got "wrong-tool"\n',
    );
    assert.equal(await pathExists(outDir), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("TOG-6730: CLI fails closed on empty-entries --previous file", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-corrupt-index-"));
  try {
    const previous = join(base, "empty-entries.json");
    await fs.writeFile(
      previous,
      JSON.stringify({ tool: "wayselect-search-index", entries: [], contentHash: "" }),
    );
    const outDir = join(base, "out");
    const result = await runRefresh([
      "bin/wayselect-search-index-refresh",
      "--previous",
      previous,
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "SearchIndexError: previousIndex.entries must be a non-empty array\n",
    );
    assert.equal(await pathExists(outDir), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("TOG-6730: CLI fails closed on missing --previous file", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "wayselect-corrupt-index-"));
  try {
    const outDir = join(base, "out");
    const result = await runRefresh([
      "bin/wayselect-search-index-refresh",
      "--previous",
      join(base, "does-not-exist.json"),
      "--out",
      outDir,
      "--now",
      NOW,
      "--max-catalog-age-hours",
      "24",
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: ENOENT/);
    assert.equal(await pathExists(outDir), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
