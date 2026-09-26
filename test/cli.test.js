import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

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
  assert.equal(
    result.provenance.snapshotHash,
    "sha256:4c3fc1cff7c83871b4f0600b0688cb87fe27cb82f6f42672460dd2dadb2a2e5d",
  );
});

async function writeTempJson(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

test("CLI denies a tampered catalog body without selecting a route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-tamper-"));
  const [catalogRaw, configuration, request] = await Promise.all([
    readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/configuration.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/request.synthetic.json", import.meta.url), "utf8"),
  ]);
  const catalogFixture = JSON.parse(catalogRaw);
  catalogFixture.catalog.northstar.models["alpha-chat"].tool_call = false;

  const catalogPath = await writeTempJson(dir, "catalog.json", catalogFixture);
  const configurationPath = await writeTempJson(dir, "configuration.json", JSON.parse(configuration));
  const requestPath = await writeTempJson(dir, "request.json", JSON.parse(request));

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "bin/wayselect",
          "--catalog",
          catalogPath,
          "--configuration",
          configurationPath,
          "--request",
          requestPath,
        ],
        { cwd: repoRoot },
      ),
    /CatalogIntegrityError: catalog body does not match provenance.snapshotHash/,
  );
});

test("CLI fails closed with stale-catalog when the feed exceeds maxCatalogAgeHours", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-stale-"));
  const [catalogRaw, configuration, requestRaw] = await Promise.all([
    readFile(new URL("../fixtures/catalog.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/configuration.synthetic.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/request.synthetic.json", import.meta.url), "utf8"),
  ]);
  const staleRequest = JSON.parse(requestRaw);
  staleRequest.evaluationTime = "2026-09-30T12:00:00.000Z";

  const catalogPath = await writeTempJson(dir, "catalog.json", JSON.parse(catalogRaw));
  const configurationPath = await writeTempJson(dir, "configuration.json", JSON.parse(configuration));
  const requestPath = await writeTempJson(dir, "request.json", staleRequest);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "bin/wayselect",
      "--catalog",
      catalogPath,
      "--configuration",
      configurationPath,
      "--request",
      requestPath,
    ],
    { cwd: repoRoot },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.equal(result.transport, null);
  assert.ok(result.selection.candidates.length > 0);
  assert.ok(
    result.selection.candidates.every(
      (candidate) =>
        candidate.eligible === false && candidate.reasons.includes("stale-catalog"),
    ),
  );
});
