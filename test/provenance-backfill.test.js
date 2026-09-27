import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ProvenanceAuditError,
  auditIngestionSnapshot,
} from "../src/provenanceAudit.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

async function committedBackfill(name) {
  const raw = await fs.readFile(new URL(`../snapshots/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

test("TOG-5289: committed backfills carry pinned provenance and verify green", async () => {
  for (const name of [
    "snapshot-20260924T120000000Z-c6cdb62e.json",
    "snapshot-20260924T120500000Z-c6cdb62e.json",
  ]) {
    const audit = auditIngestionSnapshot(await committedBackfill(name), { filename: name });

    assert.equal(audit.ok, true, `${name}: expected green, got ${audit.failures.join("; ")}`);
    assert.equal(audit.entryCount, 6);
    assert.equal(audit.contentHashVerified, true);
    assert.match(audit.provenance.source, /^synthetic:\/\//);
    assert.match(audit.provenance.snapshotHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(audit.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(audit.provenance.snapshotTimestamp)));
    assert.equal(audit.freshness.fresh, true);
  }
});

test("TOG-5289: tampered entry breaks the content-hash pin", async () => {
  const snapshot = await committedBackfill("snapshot-20260924T120000000Z-c6cdb62e.json");
  snapshot.entries[0] = { ...snapshot.entries[0], name: "Renamed by hand" };

  const audit = auditIngestionSnapshot(snapshot, { filename: "tampered.json" });

  assert.equal(audit.ok, false);
  assert.equal(audit.contentHashVerified, false);
  assert.ok(audit.failures.some((failure) => failure.startsWith("contentHash:")));
});

test("TOG-5289: stripped provenance fails the pin, entry by entry", async () => {
  const snapshot = await committedBackfill("snapshot-20260924T120000000Z-c6cdb62e.json");
  delete snapshot.provenance.source;
  delete snapshot.entries[2].routeId;

  const audit = auditIngestionSnapshot(snapshot, { filename: "stripped.json" });

  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.startsWith("provenance.source:")));
  assert.ok(audit.failures.some((failure) => failure.includes("missing routeId")));
});

test("TOG-5289: stale and future backfills are flagged, not served silently", async () => {
  const snapshot = await committedBackfill("snapshot-20260924T120000000Z-c6cdb62e.json");

  const stale = auditIngestionSnapshot(snapshot, {
    filename: "stale.json",
    now: new Date("2026-09-26T12:00:00.000Z"),
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.failures.some((failure) => failure.startsWith("stale-backfill:")));

  const future = auditIngestionSnapshot(
    { ...snapshot, collectedAt: "2026-09-24T09:00:00.000Z" },
    { filename: "future.json" },
  );
  assert.equal(future.ok, false);
  assert.ok(future.failures.some((failure) => failure.startsWith("future-backfill:")));
});

test("TOG-5289: non-staging sources are refused", async () => {
  const snapshot = await committedBackfill("snapshot-20260924T120000000Z-c6cdb62e.json");
  snapshot.provenance = {
    ...snapshot.provenance,
    source: "https://production.example.invalid/catalog",
  };
  snapshot.sourcePrefix = "https://production.example.invalid/";

  const audit = auditIngestionSnapshot(snapshot, { filename: "non-staging.json" });

  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((failure) => failure.startsWith("provenance.source:")));
  assert.ok(audit.failures.some((failure) => failure.startsWith("sourcePrefix:")));
});

test("TOG-5289: malformed audit inputs fail closed with typed errors", async () => {
  assert.throws(() => auditIngestionSnapshot(null), ProvenanceAuditError);
  assert.throws(() => auditIngestionSnapshot([], { filename: "x" }), ProvenanceAuditError);
  assert.throws(
    () => auditIngestionSnapshot({}, { maxCatalogAgeMs: -1 }),
    ProvenanceAuditError,
  );
  assert.throws(
    () => auditIngestionSnapshot({}, { maxCatalogAgeMs: Number.NaN }),
    ProvenanceAuditError,
  );
  assert.throws(() => auditIngestionSnapshot({}, null), ProvenanceAuditError);

  const empty = auditIngestionSnapshot({ tool: "other", entries: [] }, { filename: "x" });
  assert.equal(empty.ok, false);
  assert.equal(empty.entryCount, 0);
  assert.ok(empty.failures.some((failure) => failure.startsWith("entries:")));
});

test("TOG-5289: check CLI passes committed backfills with zero network", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/check-ingestion-provenance"],
    { cwd: repoRoot },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /provenance-backfill: 2\/2 backfills passed/);
  assert.match(stdout, /"networkUsed":false/);
});

test("TOG-5289: check CLI flags a stale backfill and rejects bad flags", async () => {
  const stale = await execFileAsync(
    process.execPath,
    ["bin/check-ingestion-provenance", "--now", "2026-09-26T12:00:00.000Z"],
    { cwd: repoRoot },
  ).then(
    () => assert.fail("stale backfill must exit non-zero"),
    (error) => error,
  );
  assert.match(stale.stdout ?? stale.message, /stale-backfill/);

  await assert.rejects(
    execFileAsync(process.execPath, ["bin/check-ingestion-provenance", "--bogus"], {
      cwd: repoRoot,
    }),
    /Unknown argument: --bogus/,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["bin/check-ingestion-provenance", "--max-catalog-age-hours", "not-a-number"],
      { cwd: repoRoot },
    ),
    /--max-catalog-age-hours must be a non-negative number/,
  );
});

test("TOG-5289: check CLI audits an explicit tampered file copy", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-tog5289-"));
  try {
    const snapshot = await committedBackfill("snapshot-20260924T120000000Z-c6cdb62e.json");
    snapshot.entries[1] = { ...snapshot.entries[1], name: "Tampered" };
    const tamperedPath = join(workDir, "tampered.json");
    await fs.writeFile(tamperedPath, JSON.stringify(snapshot));

    const failure = await execFileAsync(
      process.execPath,
      ["bin/check-ingestion-provenance", tamperedPath],
      { cwd: repoRoot },
    ).then(
      () => assert.fail("tampered backfill must exit non-zero"),
      (error) => error,
    );
    assert.match(failure.stdout ?? failure.message, /contentHash/);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
