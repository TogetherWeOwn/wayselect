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
