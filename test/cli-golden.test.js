import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-6045 (Gap B5): golden-output pins for --help/--version across
// subcommands. Existing cli.test.js only regex-matches fragments, so help-text
// regressions ship silently. These tests assert exact stdout bytes (and empty
// stderr, exit 0) so editing any help string fails the suite intentionally.
// Test-only: no src/bin changes.

async function runCli(args) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wayselect", ...args],
    { cwd: repoRoot },
  );
  return { stdout, stderr };
}

const GLOBAL_HELP = `wayselect — fixture-only dry-run model selection (dry-run / synthetic estimate — no live model calls, credentials, or network use)

Usage:
  wayselect select [options]    Select a route and show ranked candidates
  wayselect explain [options]   Explain per-candidate eligibility in detail
  wayselect catalog import ...  Ingest models.dev-shaped JSON into a catalog document
  wayselect --help              Show this help
  wayselect --version           Show the version

Without a subcommand, wayselect runs the legacy fixture demo (JSON with
provenance, selection, and fake transport) for backward compatibility:

  wayselect [--catalog <path>] [--configuration <path>] [--request <path>]
      [--max-catalog-age-hours <n>]

Options for select and explain:
  --catalog <path>               Catalog fixture (default: fixtures/catalog.synthetic.json)
  --configuration <path>         Support configuration (default: fixtures/configuration.synthetic.json)
  --request <path>               Request JSON: a full demo request or a bare
                                 selection {operation, requiredCapabilities,
                                 providerAllowlist, requirements} (default:
                                 fixtures/request.synthetic.json when no requirement
                                 flags are given)
  --operation <name>             Override the requested operation
  --require <cap,...>            Override required capabilities (repeatable,
                                 comma-separated)
  --allow <provider,...>         Override the provider allowlist (repeatable,
                                 comma-separated)
  --input-modalities <m,...>     Require input modalities (repeatable,
                                 comma-separated; e.g. text,image)
  --output-modalities <m,...>    Require output modalities (repeatable,
                                 comma-separated; e.g. text)
  --min-context-window <n>       Require at least <n> context-window tokens
                                 (unknown limits fail closed)
  --max-output-tokens <n>        Require at least <n> max-output tokens
                                 (unknown limits fail closed)
  --require-tools                Require tool calling (unknown data fails closed)
  --require-structured-output    Require structured output (unknown data fails closed)
  --require-reasoning            Require reasoning (unknown data fails closed)
  --evaluation-time <iso>        Override the evaluation timestamp
  --max-evidence-age-hours <n>   Override the evidence freshness limit
                                 (default: 72)
  --max-catalog-age-hours <n>    Override the catalog freshness limit
                                 (default: 24;
                                 stale/future catalogs fail closed)
  --json                         Machine-readable JSON output
  --help                         Show command help

Exit codes:
  0  a route was selected (or help/version shown)
  1  invalid input (unreadable file, bad JSON, failed validation)
  2  usage error (unknown subcommand or flag, missing value)
  3  no eligible route (output is still printed)

Examples:
  wayselect select
  wayselect select --operation chat --require toolUse --allow northstar,orbit
  wayselect explain --json
  wayselect select --request fixtures/request.synthetic.json --json
  wayselect catalog import models.json --out catalog.json

See docs/cli.md for copy-pasteable examples.
`;

const SELECT_HELP = `wayselect select — select a route, dry-run only (dry-run / synthetic estimate — no live model calls, credentials, or network use)

Usage:
  wayselect select [--catalog <path>] [--configuration <path>] [--request <path>]
      [--operation <name>] [--require <cap,...>] [--allow <provider,...>]
      [--input-modalities <m,...>] [--output-modalities <m,...>]
      [--min-context-window <n>] [--max-output-tokens <n>]
      [--require-tools] [--require-structured-output] [--require-reasoning]
      [--evaluation-time <iso>] [--max-evidence-age-hours <n>]
      [--max-catalog-age-hours <n>] [--json]

Requirements come from --request or from flags; flags override the file.
Typed requirements filter catalog entries; unknown or missing capability
data fails closed (excluded, never silently included).
Stale/future catalogs fail closed (no eligible route, exit 3).
Exit codes: 0 selected, 1 invalid input, 2 usage error, 3 no eligible route.
`;

const EXPLAIN_HELP = `wayselect explain — explain a route, dry-run only (dry-run / synthetic estimate — no live model calls, credentials, or network use)

Usage:
  wayselect explain [--catalog <path>] [--configuration <path>] [--request <path>]
      [--operation <name>] [--require <cap,...>] [--allow <provider,...>]
      [--input-modalities <m,...>] [--output-modalities <m,...>]
      [--min-context-window <n>] [--max-output-tokens <n>]
      [--require-tools] [--require-structured-output] [--require-reasoning]
      [--evaluation-time <iso>] [--max-evidence-age-hours <n>]
      [--max-catalog-age-hours <n>] [--json]

Requirements come from --request or from flags; flags override the file.
Typed requirements filter catalog entries; unknown or missing capability
data fails closed (excluded, never silently included).
Stale/future catalogs fail closed (no eligible route, exit 3).
Exit codes: 0 selected, 1 invalid input, 2 usage error, 3 no eligible route.
`;

const CATALOG_IMPORT_HELP = `wayselect catalog import — ingest models.dev-shaped JSON into a catalog document (dry-run only)

Usage:
  wayselect catalog import <file> [options]   Read a local models.dev-shaped JSON file
  wayselect catalog import --fetch [options]  Fetch https://models.dev/api.json (only networked path)

Options:
  --fetch-url <url>              Override the fetch URL (only with --fetch)
  --source <label>               Override the provenance source label
  --snapshot-timestamp <iso>     Override the provenance snapshot timestamp
  --snapshot-hash <sha256:...>   Override the provenance snapshot hash (must match the ingested body)
  --out <path>                   Write the ingested catalog document to <path>
  --json                         Machine-readable JSON summary
  --help                         Show this help

Every ingested entry lands as support state catalogued only — ingestion never
configures, enables, or produces executable URLs. Unknown or malformed fields
are quarantined with reasons; missing capabilities are never guessed.
`;

test("golden: wayselect --help pins exact bytes", async () => {
  const { stdout, stderr } = await runCli(["--help"]);
  assert.equal(stderr, "");
  assert.equal(stdout, GLOBAL_HELP);
});

test("golden: wayselect select --help pins exact bytes", async () => {
  const { stdout, stderr } = await runCli(["select", "--help"]);
  assert.equal(stderr, "");
  assert.equal(stdout, SELECT_HELP);
});

test("golden: wayselect explain --help pins exact bytes", async () => {
  const { stdout, stderr } = await runCli(["explain", "--help"]);
  assert.equal(stderr, "");
  assert.equal(stdout, EXPLAIN_HELP);
});

test("golden: wayselect catalog --help pins exact bytes", async () => {
  const { stdout, stderr } = await runCli(["catalog", "--help"]);
  assert.equal(stderr, "");
  assert.equal(stdout, CATALOG_IMPORT_HELP);
});

test("golden: wayselect catalog import --help matches catalog --help", async () => {
  const { stdout, stderr } = await runCli(["catalog", "import", "--help"]);
  assert.equal(stderr, "");
  assert.equal(stdout, CATALOG_IMPORT_HELP);
});

test("golden: wayselect --version pins exact bytes for the package version", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { stdout, stderr } = await runCli(["--version"]);
  assert.equal(stderr, "");
  assert.equal(stdout, `wayselect ${pkg.version}\n`);
  assert.match(stdout, /^wayselect \d+\.\d+\.\d+\n$/);
});
