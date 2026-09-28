import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const WORKFLOW_PATH = new URL(
  "../.github/workflows/fixture-refresh-check.yml",
  import.meta.url,
);

// TOG-5745: the daily fixture-freshness probe is pinned as a read-only
// scheduled workflow. These tests assert the automation contract against the
// workflow file as text (stdlib only — no new runtime dependencies) plus the
// live --check failure mode the scheduled job reports on.
async function readWorkflow() {
  return readFile(WORKFLOW_PATH, "utf8");
}

test("scheduler workflow is registered on a daily off-peak cron", async () => {
  const text = await readWorkflow();
  assert.match(text, /cron:\s*"23 7 \* \* \*"/);
  assert.match(text, /^\s+schedule:/m);
  assert.match(text, /workflow_dispatch:/);
});

test("scheduler workflow runs the read-only freshness probe", async () => {
  const text = await readWorkflow();
  assert.match(text, /npm run refresh:check/);
  assert.match(text, /uses:\s*actions\/checkout@v4/);
  assert.match(text, /uses:\s*actions\/setup-node@v4/);
  assert.match(text, /node-version:\s*20/);
  // No run step refreshes (--timestamp appears only in human-remediation
  // guidance inside the issue body, never as an executed command).
  assert.doesNotMatch(text, /^\s*run:.*--timestamp/m);
});

test("scheduler workflow writes nothing and needs no credentials", async () => {
  const text = await readWorkflow();
  // Read-only checkout; only issues may be written (the staleness report).
  assert.match(text, /contents:\s*read/);
  assert.doesNotMatch(text, /contents:\s*write/);
  assert.doesNotMatch(text, /git commit/);
  assert.doesNotMatch(text, /git push/);
});

test("scheduler workflow files an issue (not a commit) on staleness", async () => {
  const text = await readWorkflow();
  assert.match(text, /if:\s*failure\(\)/);
  assert.match(text, /gh issue create/);
  assert.match(text, /fixture-staleness/);
  // Dedupes: an already-open staleness issue suppresses duplicates.
  assert.match(text, /issue list.*--state open/);
  // The issue body points at the refresh script, not a silent auto-commit.
  assert.match(text, /refresh-catalog-fixtures --timestamp/);
  assert.match(text, /never by hand-editing/);
});

test("scheduled --check failure mode: stale snapshot exits non-zero", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  const staleNow = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + 48 * 60 * 60 * 1000,
  ).toISOString();
  // This is the exact failure the scheduled job surfaces as an issue.
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["bin/refresh-catalog-fixtures", "--check", "--now", staleNow],
      { cwd: repoRoot },
    ),
    /is stale/,
  );
});

test("scheduled --check green mode: fresh snapshot exits zero", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  const freshNow = new Date(
    Date.parse(catalog.provenance.snapshotTimestamp) + 60 * 60 * 1000,
  ).toISOString();
  const result = await execFileAsync(
    process.execPath,
    ["bin/refresh-catalog-fixtures", "--check", "--now", freshNow],
    { cwd: repoRoot },
  );
  assert.equal(JSON.parse(result.stdout).ok, true);
});
