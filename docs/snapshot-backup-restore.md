# Snapshot backup/restore + catalog rollback (TOG-8327)

How to back up the staging snapshots, restore one, and roll back a bad
catalog ingestion. Fixture-only, stdlib-only, no network, no credentials,
no spend. Runbook only — nothing here writes to production, and the
commands never touch the live `fixtures/` or `snapshots/` trees: every
restore is rehearsed on a scratch copy first.

Closes the gap filed under the [TOG-8283](/TOG/issues/TOG-8283#document-gap-list)
gap list: a bad ingestion had no written recovery path (who restores what,
in which order, and how the reviewer knows it worked).

## 0. What is backed up, and what restore means here

Two different artifacts, two different restores:

- **`snapshots/snapshot-*.json`** — staging-only pipeline outputs from
  `bin/wayselect-snapshot` (entries, content hash, provenance, gaps). They
  are the audit trail: `bin/check-ingestion-provenance` re-verifies them.
  Restore = copy the backup file(s) back; the audit passes or it does not.
- **`fixtures/catalog.synthetic.json`** (plus `configuration.synthetic.json`
  and `request.synthetic.json` as a trio) — the live inputs every CLI path
  reads. The catalog carries a `provenance.snapshotHash` gate
  (`src/catalog.js` `verifyCatalogSnapshotHash`): any body that does not
  match its stamped hash fails closed with `CatalogIntegrityError`.
  Rollback = byte-restore the backup file, never a hand-edit — a hand-edited
  catalog refuses to run (`catalog body does not match
  provenance.snapshotHash …, refusing tampered or stale feed`, exit 1).

Direction matters: snapshots are **derived from** the catalog
(`buildSnapshot` in `src/snapshot.js`; a pinned `--now` rebuild is
byte-identical in entries and content hash), so the catalog backup is the
recovery source and the snapshot backup is the evidence. Restoring a
snapshot never restores service — restoring the catalog does, and the
rebuilt snapshot proves it (same `contentHash`, zero removed routes).

Retention still applies: `docs/snapshot-retention.md`
(`bin/wayselect-snapshot-prune`, keep-last-10 + 30 days) governs how many
snapshots survive. Back up before pruning, not after.

## 1. Back up

Copy the snapshot files and the fixture trio to a backup directory. Verify
the backup immediately — a backup that fails `refresh --check` or the audit
is not a backup:

```sh
BACKUP=/tmp/wayselect-backup-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP"
cp snapshots/snapshot-*.json "$BACKUP/"
cp fixtures/catalog.synthetic.json fixtures/configuration.synthetic.json \
  fixtures/request.synthetic.json "$BACKUP/"
node bin/refresh-catalog-fixtures --check --catalog "$BACKUP/catalog.synthetic.json" \
  --now "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).provenance.snapshotTimestamp)' "$BACKUP/catalog.synthetic.json")"
node bin/check-ingestion-provenance --dir "$BACKUP"
```

Expected: `{"ok": true, …}` with `ageMs: 0` from the check, then
`provenance-backfill: N/N backfills passed` with exit 0 from the audit
(`N` = the number of `snapshot-*.json` files; 2 at the time of writing).
The `--now` trick pins the check clock to the recorded stamp so the result
is deterministic, not wall-clock dependent.

## 2. Restore a snapshot on a scratch copy

Never restore into the live tree first. Rehearse on a scratch copy, audit
it, then promote:

```sh
SCRATCH=$(mktemp -d wayselect-restore-XXXXXX)
cp "$BACKUP"/* "$SCRATCH/"
# simulate the loss: rm "$SCRATCH"/snapshot-*.json
cp "$BACKUP"/snapshot-*.json "$SCRATCH/"
node bin/check-ingestion-provenance --dir "$SCRATCH"
```

Expected: `PASS <name> — <n> entries pinned to synthetic://… @ <stamp>`
per file, `provenance-backfill: N/N backfills passed`, exit 0. On an empty
or wrong directory the audit fails closed instead:
`Error: no snapshot backfill files found in <dir>`, exit 1.

Only when the scratch audit is green, copy the same files into
`snapshots/` and re-run the audit there.

## 3. Detect a bad catalog ingestion

Two gates catch two different badnesses. A hand-edited or corrupted
catalog fails at the hash gate before anything runs:

```sh
node bin/refresh-catalog-fixtures --check --catalog <suspect-catalog>
# CatalogIntegrityError: catalog body does not match
# provenance.snapshotHash (claimed …, computed …);
# refusing tampered or stale feed — exit 1
```

A structurally valid but wrong ingestion (e.g. an upstream feed that
silently dropped the `orbit` provider — full hash, clean provenance,
missing routes) passes the hash gate and must be caught by diffing the
snapshot against the last good backup:

```sh
mkdir -p /tmp/suspect
node bin/wayselect-snapshot --catalog <suspect-catalog> --out /tmp/suspect \
  --now <ISO> --previous "$BACKUP/snapshot-<last-good>.json"
```
(`--out` points at scratch: without it the suspect snapshot lands in the
live `snapshots/` tree.)

Read `diffSummary`: any `removedCount > 0` names exactly which routes the
ingestion lost (`routes: 6 -> 1 (added 0, removed 5, …)` in the drill).
The Markdown report (`diff-report-….md` beside the snapshot) lists them
under `## Removed routes`. Roll back when the removed set is not an
intended decommission.

## 4. Roll back a bad catalog ingestion

1. Byte-restore the backup trio over the live fixtures (or over the
   staging inputs, same bytes):
   ```sh
   cp "$BACKUP/catalog.synthetic.json" fixtures/catalog.synthetic.json
   cp "$BACKUP/configuration.synthetic.json" fixtures/configuration.synthetic.json
   cp "$BACKUP/request.synthetic.json" fixtures/request.synthetic.json
   ```
2. Verify the gate passes (pin `--now` to the restored stamp — a bare
   `--check` reads the wall clock and goes stale once the fixture ages
   past the 24 h window):
   ```sh
   node bin/refresh-catalog-fixtures --check --catalog fixtures/catalog.synthetic.json \
     --now "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).provenance.snapshotTimestamp)' fixtures/catalog.synthetic.json)"
   ```
   Expected: `{"ok": true, …}` with `ageMs: 0`, exit 0.
3. Verify service — the demo still selects on the rolled-back set:
   ```sh
   node bin/wayselect
   ```
   Expected: `selection.status: selected`,
   `selected.routeId: northstar/alpha-chat`, fake transport,
   `networkUsed: false`.
4. Prove equivalence — rebuild the snapshot on scratch (never into the
   live `snapshots/` tree during rehearsal) and diff against the backup:
   ```sh
   node bin/wayselect-snapshot --out /tmp/rebuild-proof \
     --previous "$BACKUP/snapshot-<last-good>.json"
   ```
   Expected: the rebuilt `contentHash` equals a committed snapshot's hash
   and `diffSummary` shows `contentHashChanged: false`, `removedCount: 0`,
   `unchangedCount` = the full route count (6 at the time of writing).
   (`provenanceChanged: true` is normal — the rebuild stamps a new
   `collectedAt` while the entries stay identical.)
5. File the follow-up: what was ingested, which routes were lost (the diff
   report), the rollback evidence from steps 2–4. Then fix forward per the
   incident runbook (`docs/incident-runbook.md` §6: no roll-forward until
   the fix PR merges green).

## 5. One-command drill

`bin/accept-snapshot-restore` (`npm run accept:snapshot-restore`) runs
§1–§4 end to end on scratch copies (live fixtures and `snapshots/`
untouched) plus the full suite, and exits 0 only when all five checks
pass:

```sh
node bin/accept-snapshot-restore [--out evidence.json] [--keep-tmp]
```

```text
PASS  backup: staged backup verifies clean
PASS  restore: lost snapshots restore from backup
PASS  rollback-detect: bad ingestion diff flags removed routes
PASS  rollback: catalog backup restores service
PASS  suite: full test suite stays green

Verdict: QA <sha>: PASS (5/5 checks passed)
```

## 6. Reviewer walk (acceptance, under 10 minutes)

On a scratch copy — the reviewer runs the restore commands successfully:

1. §1 on a scratch backup: check prints `ok: true`, audit prints `N/N
   backfills passed`, both exit 0.
2. §2: delete the scratch snapshots, copy the backup back, audit passes
   `N/N` again.
3. §3: `--previous` diff against the backup flags the drill's removed
   routes (`removedCount` = routes the bad feed dropped).
4. §4 steps 2–4: check `ok: true`, demo selects `northstar/alpha-chat`
   with `networkUsed: false`, rebuilt `contentHash` reproduces a
   committed snapshot hash with `removedCount: 0`.
5. `node bin/accept-snapshot-restore` exits 0 (`5/5 checks passed`).

If steps 1–5 resolve with the evidence shown, the procedure passes.
