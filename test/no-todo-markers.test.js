// TOG-7315: debt-marker introduction gate pin.
//
// bin/check-no-todo-markers fails loudly on the four tracked debt-marker
// words (assembled at runtime below, never spelled literally — see the
// gate source for why); CI runs the same script as the marker-gate job
// (no npm ci needed). This test pins the script contract offline: clean
// exits 0 on the current tree shape, each marker word exits 1, the
// grandfathered mktemp false positives stay clean, and near-miss tokens
// (longer words, lowercase notes) never trip the gate. Sandbox runs use
// --root scratch trees in the OS temp dir, so fixtures stay marker-free
// and the gate's repo scan never sees them.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Same fragments as the gate: never spell a marker literally in this file.
const MARKER_WORDS = ["TO" + "DO", "FIX" + "ME", "X".repeat(3), "HA" + "CK"];
const MARKER_ALT = MARKER_WORDS.join("|");

async function runGate(args = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["bin/check-no-todo-markers", ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    // Usage errors print to stderr; merge both streams for assertions.
    return { code: error.code, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function stageScratch(files) {
  const dir = mkdtempSync(join(tmpdir(), "marker-gate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test("gate exits 0 on a clean tree", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dir = stageScratch({ "a.js": "const x = 1;\n", "docs/note.md": "nothing to see here\n" });
  const result = await runGate(["--root", dir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /MARKER-GATE-OK: scanned 2 files/);
});

test("each marker word exits 1 with a file:line excerpt", async (t) => {
  const dir = stageScratch({});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const marker of MARKER_WORDS) {
    writeFileSync(join(dir, "probe.js"), `// ${marker}: wire this up later\nconst ok = true;\n`);
    const result = await runGate(["--root", dir]);
    assert.equal(result.code, 1, `expected exit 1 for a marker word`);
    assert.match(result.stdout, new RegExp(`probe\\.js:1: .*(?:${MARKER_ALT})`));
    assert.match(result.stdout, /MARKER-GATE-FAIL/);
  }
});

test("grandfathered mktemp false positives stay clean", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dir = stageScratch({
    "acceptance.sh":
      'WORKDIR="$(mktemp -d wayselect-acceptance-XXXXXX)"\nREQUEST_DIR="$(mktemp -d wayselect-acceptance-request-XXXXXX)"\n',
  });
  const result = await runGate(["--root", dir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /MARKER-GATE-OK/);
});

test("near-miss tokens never trip the gate", async (t) => {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dir = stageScratch({
    "near.js": "const MYTODOS = 1;\nconst HACKSAW = 2;\n// todo: lowercase note\n// Todone deal\n",
  });
  const result = await runGate(["--root", dir]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /MARKER-GATE-OK/);
});

test("unknown argument exits 2 with usage", async () => {
  const result = await runGate(["--bogus"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /usage: node bin\/check-no-todo-markers/);
});

test("real tree scans clean at this revision", async () => {
  const result = await runGate();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /MARKER-GATE-OK: scanned \d+ files/);
});
