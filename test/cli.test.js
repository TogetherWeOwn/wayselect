import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = ["bin/wayselect"];
const FIXTURE_INPUT = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
  "--evaluation-time",
  "2026-09-24T12:00:00.000Z",
];

async function runCli(args, { expectFailure = false } = {}) {
  const cwd = new URL("..", import.meta.url);
  if (expectFailure) {
    try {
      await execFileAsync(process.execPath, [...CLI, ...args], { cwd });
    } catch (error) {
      return {
        code: error.code,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
      };
    }
    assert.fail(`expected CLI to fail for args: ${args.join(" ")}`);
  }
  const { stdout, stderr } = await execFileAsync(process.execPath, [...CLI, ...args], {
    cwd,
  });
  return { code: 0, stdout, stderr };
}

test("select prints the selected route and ranked exclusion reasons", async () => {
  const { stdout, stderr } = await runCli(["select", ...FIXTURE_INPUT]);

  assert.equal(stderr, "");
  assert.match(stdout, /dry-run \/ synthetic estimate/);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
  assert.match(stdout, /1\. northstar\/alpha-chat — eligible/);
  assert.match(stdout, /2\. orbit\/orbit-chat — eligible/);
  assert.match(
    stdout,
    /legacy\/old-chat — excluded \(provider-not-allowed, stale-evidence\)/,
  );
  assert.match(stdout, /missing-capability:toolUse/);
  assert.match(stdout, /support-state:unsupported/);
});

test("select --json emits the machine-readable shape", async () => {
  const { stdout, stderr } = await runCli(["select", ...FIXTURE_INPUT, "--json"]);
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.command, "select");
  assert.equal(result.dryRun, true);
  assert.match(result.dryRunLabel, /dry-run/);
  assert.equal(result.status, "selected");
  assert.equal(result.selectedRouteId, "northstar/alpha-chat");
  assert.equal(result.policy, "lowest-synthetic-estimated-rate-then-lexicographic-route-id");
  assert.match(result.rateDisclaimer, /not actual cost or savings/);
  assert.equal(result.evaluationTime, "2026-09-24T12:00:00.000Z");
  assert.equal(result.maxEvidenceAgeHours, 72);
  assert.ok(Array.isArray(result.rankedCandidates));
  assert.equal(result.rankedCandidates.length, 6);
  assert.deepEqual(
    result.rankedCandidates.map((candidate) => candidate.rank),
    [1, 2, 3, 4, 5, 6],
  );
  const [first, excluded] = [result.rankedCandidates[0], result.rankedCandidates[2]];
  assert.equal(first.routeId, "northstar/alpha-chat");
  assert.equal(first.eligible, true);
  assert.equal(first.estimatedRatePerMillion, 3);
  assert.deepEqual(first.reasons, []);
  assert.equal(excluded.eligible, false);
  assert.ok(excluded.reasons.length > 0);
});

test("explain details every candidate with reasons and a verdict", async () => {
  const { stdout, stderr } = await runCli(["explain", ...FIXTURE_INPUT]);

  assert.equal(stderr, "");
  assert.match(stdout, /dry-run explain/);
  assert.match(stdout, /Request: operation=chat, require=\[toolUse\], allow=\[northstar, orbit\]/);
  assert.match(stdout, /northstar\/alpha-chat: eligible/);
  assert.match(stdout, /legacy\/old-chat: excluded/);
  assert.match(stdout, /- provider-not-allowed/);
  assert.match(stdout, /- stale-evidence/);
  assert.match(stdout, /verdict: selected northstar\/alpha-chat/);
});

test("explain --json uses the same machine shape under the explain command", async () => {
  const { stdout } = await runCli(["explain", ...FIXTURE_INPUT, "--json"]);
  const result = JSON.parse(stdout);

  assert.equal(result.command, "explain");
  assert.equal(result.selectedRouteId, "northstar/alpha-chat");
  assert.equal(result.rankedCandidates.length, 6);
});

test("select reads defaults from the demo request fixture", async () => {
  const { stdout } = await runCli(["select"]);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
});

test("select with a bare selection request file resolves requirements from it", async () => {
  const { stdout } = await runCli([
    "select",
    "--request",
    "fixtures/request.synthetic.json",
  ]);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
});

test("no eligible route still prints output and exits 3", async () => {
  const { code, stdout, stderr } = await runCli(
    ["select", "--operation", "chat", "--require", "vision", "--allow", "northstar"],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  assert.equal(stderr, "");
  assert.match(stdout, /No eligible route/);
  assert.match(stdout, /missing-capability:vision/);
});

test("missing request input exits 1 with guidance", async () => {
  const { code, stderr } = await runCli(["select", "--operation", "chat"], {
    expectFailure: true,
  });

  assert.equal(code, 1);
  assert.match(stderr, /provider allowlist is required/);
});

test("unknown subcommand exits 2", async () => {
  const { code, stderr } = await runCli(["frobnicate"], { expectFailure: true });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Unknown subcommand/);
});

test("unknown flag exits 2", async () => {
  const { code, stderr } = await runCli(["select", ...FIXTURE_INPUT, "--nope"], {
    expectFailure: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Unknown flag for select/);
});

test("missing flag value exits 2", async () => {
  const { code, stderr } = await runCli(["select", "--operation"], {
    expectFailure: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Missing value for --operation/);
});

test("unreadable request file exits 1", async () => {
  const { code, stderr } = await runCli(["select", "--request", "fixtures/missing.json"], {
    expectFailure: true,
  });

  assert.equal(code, 1);
  assert.match(stderr, /Cannot read fixtures\/missing\.json/);
});

test("--help exits 0 with usage and exit codes", async () => {
  const { stdout, stderr } = await runCli(["--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /wayselect select \[options\]/);
  assert.match(stdout, /wayselect explain \[options\]/);
  assert.match(stdout, /Exit codes:/);
});

test("select --help exits 0 with command usage", async () => {
  const { stdout } = await runCli(["select", "--help"]);

  assert.match(stdout, /wayselect select/);
  assert.match(stdout, /Exit codes: 0 selected/);
});

test("--version exits 0 with the package version", async () => {
  const { stdout, stderr } = await runCli(["--version"]);

  assert.equal(stderr, "");
  assert.match(stdout, /^wayselect \d+\.\d+\.\d+\n$/);
});
