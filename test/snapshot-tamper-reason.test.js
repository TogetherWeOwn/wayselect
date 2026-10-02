// TOG-8613: pin the stable exclusion reason for hand-edited (hash-mismatch)
// snapshots.
//
// Distinct from TOG-7660: that card covers the `declaredHashVerified` gap in
// `buildSnapshot` (the provenance body-hash and the canonical entry-hash are
// different hash domains, so the declared-hash comparison can never pass).
// This card covers the same-domain tamper check in `auditIngestionSnapshot`
// (src/provenanceAudit.js): the snapshot file's recorded `contentHash`
// against the recomputed `computeContentHash(entries)`. A hand edit to any
// entry breaks that comparison, and the audit must report the stable tamper
// reason below — not just any `contentHash:`-prefixed failure (that prefix
// also covers malformed hashes and recompute errors, so prefix-only pins
// cannot tell tampering apart from bad input).

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { auditIngestionSnapshot } from "../src/provenanceAudit.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

// Stable halves of the tamper failure in src/provenanceAudit.js. The
// parenthesised recorded/recomputed hashes are dynamic by design, so the pin
// asserts the fixed prefix and the fixed tamper phrase — never the hashes.
const TAMPER_REASON_PREFIX =
  "contentHash: recomputed hash does not match the recorded hash";
const TAMPER_REASON_PHRASE = "backfill may be tampered or edited by hand";

const BACKFILL = "snapshot-20260924T120000000Z-c6cdb62e.json";

async function committedBackfill(name) {
  const raw = await fs.readFile(new URL(`../snapshots/${name}`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

test("TOG-8613: hand-edited entry pins the stable tamper reason", async () => {
  const snapshot = await committedBackfill(BACKFILL);
  snapshot.entries[0] = { ...snapshot.entries[0], name: "Renamed by hand" };

  const audit = auditIngestionSnapshot(snapshot, { filename: "tampered.json" });

  assert.equal(audit.ok, false);
  assert.equal(audit.contentHashVerified, false);
  const tamper = audit.failures.filter((failure) =>
    failure.startsWith(TAMPER_REASON_PREFIX),
  );
  assert.equal(
    tamper.length,
    1,
    `expected exactly one tamper failure, got: ${audit.failures.join("; ")}`,
  );
  assert.ok(
    tamper[0].includes(TAMPER_REASON_PHRASE),
    `tamper failure must name hand-editing: ${tamper[0]}`,
  );
  // TOG-7660 independence: the declared-hash placeholder is recorded, not
  // gated — this verdict rides on contentHashVerified alone, so a future
  // declared-hash fix must not move this reason.
  assert.equal(typeof audit.declaredHashVerified, "boolean");
});

test("TOG-8613: pristine backfill carries no tamper reason", async () => {
  const audit = auditIngestionSnapshot(await committedBackfill(BACKFILL), {
    filename: BACKFILL,
  });

  assert.equal(audit.ok, true, `expected green, got ${audit.failures.join("; ")}`);
  assert.equal(audit.contentHashVerified, true);
  assert.ok(
    audit.failures.every((failure) => !failure.startsWith(TAMPER_REASON_PREFIX)),
    "pristine backfill must not report the tamper reason",
  );
});

test("TOG-8613: check CLI surfaces the stable tamper reason for a hand-edited copy", async () => {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-tog8613-"));
  try {
    const snapshot = await committedBackfill(BACKFILL);
    snapshot.entries[2] = { ...snapshot.entries[2], name: "Tampered" };
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
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}${failure.message ?? ""}`;
    assert.match(output, /recomputed hash does not match the recorded hash/);
    assert.match(output, /tampered or edited by hand/);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
