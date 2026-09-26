import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { stableStringify } from "../src/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Independent reimplementation of the recorded-hash contract: canonical hash
// of the stored catalog body must equal the stamped snapshotHash. Derived
// from the library primitive, not the script under test.
function expectedSnapshotHash(catalogBody) {
  return `sha256:${createHash("sha256").update(stableStringify(catalogBody), "utf8").digest("hex")}`;
}

async function runRefresh(args, { cwd } = {}) {
  return execFileAsync(process.execPath, ["bin/refresh-catalog-fixtures", ...args], {
    cwd: cwd ?? repoRoot,
  });
}

async function stageScratchFixtures() {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-refresh-"));
  const names = {
    catalog: join(dir, "catalog.json"),
    configuration: join(dir, "configuration.json"),
    request: join(dir, "request.json"),
  };
  await Promise.all(
    [
      ["fixtures/catalog.synthetic.json", names.catalog],
      ["fixtures/configuration.synthetic.json", names.configuration],
      ["fixtures/request.synthetic.json", names.request],
    ].map(async ([source, target]) =>
      writeFile(target, await readFile(new URL(`../${source}`, import.meta.url), "utf8")),
    ),
  );
  return names;
}

function refreshArgs(names, extra = []) {
  return [
    "--catalog",
    names.catalog,
    "--configuration",
    names.configuration,
    "--request",
    names.request,
    ...extra,
  ];
}

// A timestamp strictly ahead of the live snapshot, derived per run so the
// tests stay valid across real refreshes.
async function futureTimestamp(names, offsetMs = 60 * 60 * 1000) {
  const catalog = JSON.parse(await readFile(names.catalog, "utf8"));
  return new Date(Date.parse(catalog.provenance.snapshotTimestamp) + offsetMs).toISOString();
}

test("refresh stamps the recorded provenance hash deterministically", async () => {
  const names = await stageScratchFixtures();
  const stamp = await futureTimestamp(names);

  const first = await runRefresh(refreshArgs(names, ["--timestamp", stamp]));
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.ok, true);
  assert.equal(firstReport.changed, true);
  const stamped = JSON.parse(await readFile(names.catalog, "utf8"));

  // The stamped hash is the canonical hash of the stored catalog body.
  assert.equal(stamped.provenance.snapshotHash, expectedSnapshotHash(stamped.catalog));
  assert.equal(
    stamped.provenance.snapshotHash,
    firstReport.provenance.snapshotHash,
  );

  // Same timestamp is a byte-identical no-op: acceptance is re-runnable.
  const snapshot = {
    catalog: await readFile(names.catalog, "utf8"),
    configuration: await readFile(names.configuration, "utf8"),
    request: await readFile(names.request, "utf8"),
  };
  const second = await runRefresh(refreshArgs(names, ["--timestamp", stamp]));
  assert.equal(JSON.parse(second.stdout).changed, false);
  assert.equal(await readFile(names.catalog, "utf8"), snapshot.catalog);
  assert.equal(await readFile(names.configuration, "utf8"), snapshot.configuration);
  assert.equal(await readFile(names.request, "utf8"), snapshot.request);
});

test("refresh preserves relative offsets across the fixture set", async () => {
  const names = await stageScratchFixtures();
  const before = {
    catalog: JSON.parse(await readFile(names.catalog, "utf8")),
    configuration: JSON.parse(await readFile(names.configuration, "utf8")),
    request: JSON.parse(await readFile(names.request, "utf8")),
  };
  const beforeSnapshot = Date.parse(before.catalog.provenance.snapshotTimestamp);

  await runRefresh(refreshArgs(names, ["--timestamp", await futureTimestamp(names)]));
  const after = {
    catalog: JSON.parse(await readFile(names.catalog, "utf8")),
    configuration: JSON.parse(await readFile(names.configuration, "utf8")),
    request: JSON.parse(await readFile(names.request, "utf8")),
  };
  const deltaMs = Date.parse(after.catalog.provenance.snapshotTimestamp) - beforeSnapshot;
  assert.ok(deltaMs > 0);

  // Intentionally stale evidence stays stale by exactly the same margin.
  const beforeEvidence = before.configuration.candidates.map((candidate) =>
    Date.parse(candidate.evidence.observedAt),
  );
  const afterEvidence = after.configuration.candidates.map((candidate) =>
    Date.parse(candidate.evidence.observedAt),
  );
  assert.deepEqual(
    afterEvidence.map((observedAt, index) => observedAt - beforeEvidence[index]),
    beforeEvidence.map(() => deltaMs),
  );

  // Evaluation keeps its distance ahead of the snapshot.
  assert.equal(
    Date.parse(after.request.evaluationTime) -
      Date.parse(after.catalog.provenance.snapshotTimestamp),
    Date.parse(before.request.evaluationTime) - beforeSnapshot,
  );

  // The catalog body itself is untouched: only provenance moved.
  assert.deepEqual(after.catalog.catalog, before.catalog.catalog);
});

test("check verifies the recorded hash and rejects tampering", async () => {
  const names = await stageScratchFixtures();
  const stamp = await futureTimestamp(names);
  await runRefresh(refreshArgs(names, ["--timestamp", stamp]));

  const fresh = await runRefresh([
    "--check",
    "--catalog",
    names.catalog,
    "--now",
    new Date(Date.parse(stamp) + 60 * 60 * 1000).toISOString(),
    "--max-age-hours",
    "24",
  ]);
  const report = JSON.parse(fresh.stdout);
  assert.equal(report.ok, true);
  const stamped = JSON.parse(await readFile(names.catalog, "utf8"));
  assert.equal(report.snapshotHash, stamped.provenance.snapshotHash);

  const tampered = structuredClone(stamped);
  tampered.catalog.orbit.models["orbit-chat"].cost.input = 999;
  await writeFile(names.catalog, JSON.stringify(tampered, null, 2));
  await assert.rejects(
    runRefresh(["--check", "--catalog", names.catalog]),
    /snapshotHash mismatch/,
  );
});

test("check fails closed on stale snapshots", async () => {
  const names = await stageScratchFixtures();
  const stamp = await futureTimestamp(names);
  await runRefresh(refreshArgs(names, ["--timestamp", stamp]));

  await assert.rejects(
    runRefresh([
      "--check",
      "--catalog",
      names.catalog,
      "--now",
      new Date(Date.parse(stamp) + 48 * 60 * 60 * 1000).toISOString(),
      "--max-age-hours",
      "24",
    ]),
    /is stale/,
  );
});

test("refresh refuses to rewind provenance and rejects unknown fields", async () => {
  const names = await stageScratchFixtures();
  const stamp = await futureTimestamp(names);
  await runRefresh(refreshArgs(names, ["--timestamp", stamp]));

  // Rewinding the snapshot clock fails closed and leaves files untouched.
  const before = await readFile(names.catalog, "utf8");
  await assert.rejects(
    runRefresh(refreshArgs(names, ["--timestamp", await futureTimestamp(names, -60000)])),
    /refusing to rewind provenance/,
  );
  assert.equal(await readFile(names.catalog, "utf8"), before);

  // Unknown catalog fields fail closed through the library boundary.
  const stamped = JSON.parse(before);
  stamped.catalog.northstar.models["alpha-chat"].endpoint = "https://example.invalid/models";
  await writeFile(names.catalog, JSON.stringify(stamped, null, 2));
  await assert.rejects(
    runRefresh(refreshArgs(names, ["--timestamp", await futureTimestamp(names, 3600000)])),
    /unknown field: endpoint/,
  );
});
