// TOG-5885: guard test — the eligibility reason glossary must document every
// reason code the evaluator can emit. Derives the emitted set from the source
// (src/eligibility.js reason literals + templates) and asserts each is covered
// in docs/eligibility-reasons.md. A new reason in the evaluator without a
// glossary entry fails here by design (node:test, stdlib only).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const source = readFileSync(new URL("../src/eligibility.js", import.meta.url), "utf8");
const glossary = readFileSync(
  new URL("../docs/eligibility-reasons.md", import.meta.url),
  "utf8",
);

// Out of scope by spec (TOG-5885): snapshot/validation labels that are never
// evaluator reasons. They must NOT force glossary entries.
const OUT_OF_SCOPE = new Set(["missing-rates", "stale-catalog-fail-closed"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fixed reason literals are plain quoted strings on reason-emitting lines
// (reasons.push("..."), return ["..."], catalogReason ternary). Template
// literals carry ${...} placeholders.
function extractEmitted() {
  const fixed = new Set();
  const templates = new Set();
  for (const line of source.split("\n")) {
    const isReasonLine =
      line.includes("reasons.push") ||
      line.includes("catalogReason") ||
      /return\s+\[/.test(line);
    if (!isReasonLine) {
      continue;
    }
    for (const match of line.matchAll(/"([^"]+)"/g)) {
      const token = match[1];
      if (/^[a-z][a-z0-9-]*(?::[A-Za-z]+)*$/.test(token)) {
        fixed.add(token);
      }
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1];
      if (token.includes("${")) {
        templates.add(token);
      } else if (/^[a-z][a-z0-9-]*(?::[A-Za-z]+)*$/.test(token)) {
        fixed.add(token);
      }
    }
  }
  return { fixed, templates };
}

function templatePrefix(template) {
  return template.slice(0, template.indexOf("${"));
}

// A template counts as documented only when the glossary names the parameterized
// form explicitly (backticked span with a <placeholder>), not just an example.
function templateDocumented(prefix) {
  const pattern = new RegExp(`\`${escapeRegExp(prefix)}[^\\\`]*<[^\\\`]*>[^\\\`]*\``);
  return pattern.test(glossary);
}

test("glossary documents every fixed reason literal emitted by src/eligibility.js", () => {
  const { fixed } = extractEmitted();
  assert.ok(
    fixed.size > 0,
    "extraction found no fixed reasons — the parser is broken, not the glossary",
  );
  const undocumented = [...fixed]
    .filter((code) => !OUT_OF_SCOPE.has(code))
    .filter((code) => !glossary.includes(`\`${code}\``))
    .sort();
  assert.deepEqual(
    undocumented,
    [],
    `undocumented evaluator reasons (add them to docs/eligibility-reasons.md): ${undocumented.join(", ")}`,
  );
});

test("glossary documents every reason template explicitly (not just examples)", () => {
  const { templates } = extractEmitted();
  assert.ok(
    templates.size > 0,
    "extraction found no reason templates — the parser is broken, not the glossary",
  );
  const prefixes = [...new Set([...templates].map(templatePrefix))].sort();
  const undocumented = prefixes.filter((prefix) => !templateDocumented(prefix));
  assert.deepEqual(
    undocumented,
    [],
    `template families without an explicit <placeholder> entry in docs/eligibility-reasons.md: ${undocumented.join(", ")}`,
  );
});

test("glossary covers 100% of concrete reason codes emitted in tests", () => {
  const { templates } = extractEmitted();
  const prefixes = [...new Set([...templates].map(templatePrefix))];
  const testDir = new URL(".", import.meta.url);
  const files = readdirSync(testDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => entry.name)
    .filter((name) => name !== "eligibility-reasons-glossary.test.js");
  const tokenPattern =
    /["'`](support-state:[A-Za-z-]+|provider-not-allowed|operation-not-[a-z-]+|(?:missing|unsupported)-capability:[A-Za-z]+|missing-modality:(?:input|output):[A-Za-z]+|insufficient-[a-z-]+|missing-evidence|invalid-evidence|future-evidence|stale-evidence|stale-catalog|future-catalog)["'`]/g;
  const seen = new Set();
  for (const name of files) {
    const body = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    for (const match of body.matchAll(tokenPattern)) {
      seen.add(match[1]);
    }
  }
  const uncovered = [...seen]
    .filter((code) => !OUT_OF_SCOPE.has(code))
    .filter(
      (code) =>
        !glossary.includes(`\`${code}\``) &&
        !prefixes.some((prefix) => code.startsWith(prefix)),
    )
    .sort();
  assert.deepEqual(
    uncovered,
    [],
    `test-emitted codes missing from docs/eligibility-reasons.md: ${uncovered.join(", ")}`,
  );
});
