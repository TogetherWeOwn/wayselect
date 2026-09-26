import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("fixture CLI demonstrates catalog to explanation with fake transport", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wayselect"],
    { cwd: new URL("..", import.meta.url) },
  );
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.earlyDevelopment, true);
  assert.equal(result.mode, "dry-run-only");
  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
  assert.equal(result.transport.adapter, "fake");
  assert.equal(result.transport.networkUsed, false);
});

test("CLI --dry-run prints each eligibility check and the final verdict", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wayselect", "--dry-run"],
    { cwd: new URL("..", import.meta.url) },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /dry-run eligibility trace/);
  assert.match(stdout, /northstar\/alpha-chat: eligible/);
  assert.match(stdout, /\[pass\] support-state/);
  assert.match(stdout, /\[pass\] provider-allowlist/);
  assert.match(stdout, /\[pass\] operation-catalogued/);
  assert.match(stdout, /\[pass\] operation-configured/);
  assert.match(stdout, /\[pass\] capability:toolUse/);
  assert.match(stdout, /\[pass\] evidence-freshness/);
  assert.match(stdout, /legacy\/old-chat: excluded/);
  assert.match(stdout, /\[fail\] provider-allowlist \(provider-not-allowed\)/);
  assert.match(stdout, /\[fail\] evidence-freshness \(stale-evidence\)/);
  assert.match(stdout, /orbit\/retired-chat: excluded/);
  assert.match(stdout, /\[fail\] support-state \(support-state:unsupported\)/);
  assert.match(stdout, /\[skipped\] evidence-freshness \(evidence-not-evaluated\)/);
  assert.match(stdout, /verdict: selected northstar\/alpha-chat/);
});
