# Snapshot retention policy (TOG-5740)

`snapshots/` accumulates timestamped `snapshot-*.json` files from
`bin/wayselect-snapshot`. Without a retention rule the directory grows
without bound. This doc states the rule; `bin/wayselect-snapshot-prune`
enforces it.

## Policy

1. **Only `snapshot-*.json` files are ever prune candidates.** Diff reports
   (`diff-report-*.md`, `sample-*.md`) and anything else in the directory
   is always skipped — the planner reports them under `skipped` and the CLI
   never deletes them.
2. **Keep-last floor (default 10).** The 10 newest snapshots are always kept,
   regardless of age. A prune can never empty the directory.
3. **Max age (default 30 days).** A snapshot past the keep-last floor is
   pruned only when it is also older than 30 days. Young overflow is kept —
   a burst of same-day runs is never deleted for being numerous.

In short: keep the 10 newest, keep anything younger than 30 days, prune old
overflow. With the current cadence (a handful of snapshots per refresh) the
directory settles at ~10 files.

## Usage

Dry-run is the default — it lists what would be deleted and deletes nothing:

```sh
node bin/wayselect-snapshot-prune --dir snapshots
```

Delete for real with `--apply`:

```sh
node bin/wayselect-snapshot-prune --dir snapshots --apply
```

Tune the policy:

```sh
node bin/wayselect-snapshot-prune --dir snapshots --keep-last 20 --max-age-days 90
node bin/wayselect-snapshot-prune --dir snapshots --now 2026-09-27T00:00:00.000Z
```

Or via npm: `npm run prune:snapshots` (dry-run), add `--apply` after `--`
to delete.

## Output contract

Success prints a JSON plan to stdout with empty stderr:

```text
{
  "dryRun": true,
  "dir": "<absolute path>",
  "keepLast": 10,
  "maxAgeDays": 30,
  "now": "<ISO clock used>",
  "kept": ["snapshot-...json"],
  "pruned": ["snapshot-...json"],
  "deleted": [],
  "skipped": ["diff-report-....md"]
}
```

- `pruned` lists deletion candidates; in dry-run mode nothing is deleted.
- With `--apply`, candidates move to `deleted` and `pruned` is empty.
- `skipped` lists non-snapshot files that were never candidates.

Exit codes follow the repo convention: 0 when the plan ran, 1 on runtime
failures (unreadable directory, failed deletion), 2 on usage errors
(unknown flag, missing value, bad `--keep-last`/`--max-age-days`/`--now`).

## Safety notes

- The keep-last floor counts only snapshot files, so deleting everything
  old is impossible: at least `--keep-last` files always survive.
- Tests run the CLI against scratch copies (mkdtemp), never against the
  committed `snapshots/` directory.
- New snapshot filenames must keep the `snapshot-*.json` shape to stay
  under retention; anything else is ignored by the pruner.
