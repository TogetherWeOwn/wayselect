// TOG-8632: golden pin for `search-index --check` stale-catalog human output.
//
// Distinct from TOG-7300/PR #206 (catalog import quarantine golden) and from
// the non-check refresh fail-closed path (TOG-5460 in test/search-index.test.js,
// which asserts exit 1 + empty stdout + `Error: refusing stale...` on stderr).
// The --check probe instead prints the human-readable PASS/FAIL table to
// stdout, exits 1, and leaves stderr empty. This test pins those bytes.
//
// Staleness clock: 28 days after the live fixture snapshot stamp, so the
// expected age (2419200000ms) is fixed and the test stays green across
// provenance timestamp refreshes without edits. The content hash is the
// catalog-body hash (timestamp-independent); a catalog body change breaks
// this golden intentionally.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

const CONTENT_HASH =
  "sha256:c6cdb62e31ffe7f9f6c4fd53da4e584ea50e53fef641e95f1a8b3aab9804096c";

// Exact human-readable stdout for a stale --check (28d age, 24h limit).
// Note the em-dash (U+2014) and double space after PASS/FAIL, matching
// bin/wayselect-search-index-refresh.
const EXPECTED_STALE_CHECK_STDOUT =
  `PASS  R1-source — staging source synthetic://wayselect/fixture-v1\n` +
  `PASS  R2-parity — 6 index entries cover every catalog route\n` +
  `PASS  R3-stable — consecutive builds agree on ${CONTENT_HASH}\n` +
  `PASS  R4-idempotent — reload reports changed:false at ${CONTENT_HASH}\n` +
  `FAIL  R5-fresh — snapshot age 2419200000ms exceeds limit 86400000ms\n` +
  `refresh-probe: 4/5 checks passed (content ${CONTENT_HASH})\n`;

async function staleNowIso() {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
  );
  const snapshotMs = Date.parse(fixture.provenance.snapshotTimestamp);
  assert.ok(Number.isFinite(snapshotMs), "fixture snapshotTimestamp must parse");
  return new Date(snapshotMs + 28 * 24 * 60 * 60 * 1000).toISOString();
}

test("TOG-8632: --check on stale catalog pins human-readable copy", async () => {
  const staleNow = await staleNowIso();
  let result;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "bin/wayselect-search-index-refresh",
        "--check",
        "--max-catalog-age-hours",
        "24",
        "--now",
        staleNow,
      ],
      { cwd: repoRoot },
    );
    result = { code: 0, stdout, stderr };
  } catch (error) {
    result = { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  assert.equal(result.code, 1, "stale --check exits 1");
  assert.equal(result.stderr, "", "stale --check writes nothing to stderr");
  assert.equal(result.stdout, EXPECTED_STALE_CHECK_STDOUT, "stale --check stdout must match the golden copy byte-for-byte");
});
