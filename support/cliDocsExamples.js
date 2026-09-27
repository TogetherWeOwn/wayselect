// Shared docs/cli.md doctest helpers (TOG-5743).
//
// Extracted verbatim from test/cli-docs-examples.test.js (TOG-5725) so the
// doctest suite and its negative control exercise the SAME parsing logic: if
// the fence regex or command extraction ever changes, both track it together.
// Stdlib only; no fixtures or clocks here (see support/helpers.js for those).

export function normalizeTimestamps(value) {
  return value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<TIMESTAMP>");
}

// Split the doc into an ordered list of fenced blocks: { lang, body }.
export function fencedBlocks(markdown) {
  const blocks = [];
  const pattern = /```(\w+)\n(.*?)```/gs;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    blocks.push({ lang: match[1], body: match[2] });
  }
  return blocks;
}

// Extract runnable `node bin/wayselect select|explain ...` commands from an sh
// block: join continuations, cut `; echo ...` suffixes, skip help/version and
// error-path examples covered by cli.test.js.
export function exampleCommands(shBody) {
  const joined = shBody.replace(/\\\n/g, " ");
  const commands = [];
  for (const rawLine of joined.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("node bin/wayselect")) {
      continue;
    }
    const argv = line
      .split(";")[0]
      .trim()
      .split(/\s+/)
      .slice(2);
    if (argv.includes("--help") || argv.includes("--version")) {
      continue;
    }
    if (line.includes("missing.json") || line.includes("--nope") || line.includes("frobnicate")) {
      continue;
    }
    if (argv[argv.length - 1] === "--operation") {
      continue; // missing-value usage error, covered by cli.test.js
    }
    if (argv[0] !== "select" && argv[0] !== "explain") {
      continue;
    }
    commands.push(argv);
  }
  return commands;
}

export function substituteClock(argv, evaluationTime) {
  return argv.map((token, index) =>
    argv[index - 1] === "--evaluation-time" ? evaluationTime : token,
  );
}

// First sh block with a following text block that yields at least one runnable
// select/explain example. Returns { argv, expectedText } or null.
export function firstExampleWithExpectation(markdown) {
  const blocks = fencedBlocks(markdown);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.lang !== "sh") {
      continue;
    }
    const next = blocks[index + 1];
    if (!next || next.lang !== "text") {
      continue;
    }
    const expectedText = next.body
      .split("\n")
      .filter((line) => !line.startsWith("exit="))
      .join("\n")
      .trim();
    const commands = exampleCommands(block.body).filter(
      (argv) => !argv.includes("vision") && !argv.includes("--json"),
    );
    if (commands.length > 0) {
      return { argv: commands[0], expectedText };
    }
  }
  return null;
}
