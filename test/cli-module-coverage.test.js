// TOG-6372: guard test — the CLI-vs-modules audit must stay complete.
//
// docs/cli-module-coverage.md records every export of src/searchIndex.js,
// src/snapshot.js and src/provenanceAudit.js against its CLI caller. This
// test fails by design when the record drifts:
//   1. a new export in any of the three modules without a backticked doc row,
//   2. a backticked bin/ path in the doc that does not exist on disk,
//   3. the doc missing from the README.md docs index.
// Static checks only (node:test, stdlib only): no subprocesses, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const MODULES = [
  "src/searchIndex.js",
  "src/snapshot.js",
  "src/provenanceAudit.js",
];
const DOC = new URL("../docs/cli-module-coverage.md", import.meta.url);
const README = new URL("../README.md", import.meta.url);

function read(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

// Every `export const|function|class NAME` at line start, plus any names in
// `export { ... }` blocks (none today; future-proofing so a re-exported
// name cannot slip past the doc).
function extractExports(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const alias = part.match(/as\s+([A-Za-z_$][\w$]*)\s*$/);
      const plain = part.trim().match(/^([A-Za-z_$][\w$]*)$/);
      if (alias) names.add(alias[1]);
      else if (plain) names.add(plain[1]);
    }
  }
  return names;
}

test("TOG-6372: every export of the three audited modules has a doc row", () => {
  const doc = readFileSync(DOC, "utf8");
  const missing = [];
  let total = 0;
  for (const rel of MODULES) {
    const names = extractExports(read(rel));
    assert.ok(
      names.size > 0,
      `extraction found no exports in ${rel} — the parser is broken, not the doc`,
    );
    total += names.size;
    for (const name of [...names].sort()) {
      // Table-row anchor: the export must own a `| \`name\` |` row, so
      // deleting the row (leaving a prose backtick behind) still fails.
      if (!doc.includes(`| \`${name}\` |`)) missing.push(`${rel}: ${name}`);
    }
  }
  assert.ok(total >= 21, `expected >=21 exports, found ${total} — the parser is broken`);
  assert.deepEqual(
    missing,
    [],
    `exports without a backticked row in docs/cli-module-coverage.md (add the row): ${missing.join(", ")}`,
  );
});

test("TOG-6372: every backticked bin/ path in the doc exists", () => {
  const doc = readFileSync(DOC, "utf8");
  const paths = new Set();
  for (const match of doc.matchAll(/`((?:bin\/)[^`]*?)`/g)) {
    const span = match[1].trim();
    if (/^bin\/[\w.-]+$/.test(span)) paths.add(span);
  }
  assert.ok(paths.size > 0, "found no bin/ paths in the doc — the extractor is broken");
  const dangling = [...paths]
    .filter((rel) => !existsSync(new URL(`../${rel}`, import.meta.url)))
    .sort();
  assert.deepEqual(
    dangling,
    [],
    `backticked bin/ paths in docs/cli-module-coverage.md that do not exist: ${dangling.join(", ")}`,
  );
});

test("TOG-6372: the coverage doc is linked from the README docs index", () => {
  const readme = readFileSync(README, "utf8");
  assert.ok(
    readme.includes("docs/cli-module-coverage.md"),
    "README.md docs index must link docs/cli-module-coverage.md (CONTRIBUTING.md: new docs specs go in the index)",
  );
});
