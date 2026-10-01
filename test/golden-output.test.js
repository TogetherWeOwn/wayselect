import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluationNow, readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// TOG-4800 golden-output tests, ported to the single-command CLI (TOG-5265).
// The CLI takes no subcommand: selection inputs travel in a --request JSON
// file (defaults: fixtures/request.synthetic.json). Stdout is machine JSON;
// provenance.fetchedAt is normalized to FETCHED_AT_NORMALIZED_FOR_TEST.
// The expected snapshot clock follows the refreshed fixture; every other
// byte stays pinned to test/golden/default.json. Any change to the output
// shape (or the fixture snapshot hash) is a deliberate, reviewed act:
// regenerate the golden and say why in the commit.
//
// Selection is input-order independent (candidates sort by route id, then by
// synthetic rate): the determinism test asserts the reversed allowlist order
// still picks northstar/alpha-chat.

const FETCHED_AT_PLACEHOLDER = "FETCHED_AT_NORMALIZED_FOR_TEST";
const MAX_EVIDENCE_AGE_HOURS = 72;

async function runCli(requestSelection) {
  const extraArgs = [];
  if (requestSelection !== undefined) {
    const dir = await mkdtemp(join(tmpdir(), "wayselect-golden-"));
    const requestPath = join(dir, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify(
        {
          evaluationTime: evaluationNow().toISOString(),
          maxEvidenceAgeHours: MAX_EVIDENCE_AGE_HOURS,
          selection: requestSelection,
        },
        null,
        2,
      ),
    );
    extraArgs.push("--request", requestPath);
  }
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wayselect", ...extraArgs],
    { cwd: repoRoot },
  );
  return { stdout, stderr };
}

function normalizeForGolden(stdout) {
  const parsed = JSON.parse(stdout);
  parsed.provenance.fetchedAt = FETCHED_AT_PLACEHOLDER;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

async function golden(name) {
  const expected = JSON.parse(await readFile(new URL(`./golden/${name}`, import.meta.url), "utf8"));
  const fixture = await readFixture("catalog.synthetic.json");
  expected.provenance.snapshotTimestamp = fixture.provenance.snapshotTimestamp;
  return `${JSON.stringify(expected, null, 2)}\n`;
}

test("default CLI output is byte-identical to the golden file (fetchedAt normalized)", async () => {
  const { stdout, stderr } = await runCli();

  assert.equal(stderr, "");
  assert.equal(normalizeForGolden(stdout), await golden("default.json"));
});

test("default CLI output selects northstar/alpha-chat with fake transport", async () => {
  const { stdout } = await runCli();
  const parsed = JSON.parse(stdout);

  assert.equal(parsed.selection.status, "selected");
  assert.equal(parsed.selection.selected.routeId, "northstar/alpha-chat");
  assert.equal(parsed.transport.adapter, "fake");
  assert.equal(parsed.transport.networkUsed, false);
  assert.equal(
    parsed.provenance.snapshotHash,
    "sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d",
  );
});

test("no-eligible-route request fails closed with null transport", async () => {
  const { stdout, stderr } = await runCli({
    operation: "chat",
    requiredCapabilities: ["vision"],
    providerAllowlist: ["northstar", "orbit"],
  });
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(parsed.selection.status, "no-eligible-route");
  assert.equal(parsed.selection.selected, null);
  assert.equal(parsed.transport, null);
});

test("selection is deterministic under reversed allowlist order", async () => {
  const { stdout } = await runCli({
    operation: "chat",
    requiredCapabilities: ["toolUse"],
    providerAllowlist: ["orbit", "northstar"],
  });

  assert.equal(
    JSON.parse(stdout).selection.selected.routeId,
    "northstar/alpha-chat",
  );
});
