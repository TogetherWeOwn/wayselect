// Atomic file writes for Wayselect (TOG-6726).
//
// `bin/wayselect-snapshot` wrote snapshots and diff reports with a direct
// `writeFile`: a crash mid-write left a truncated file that later runs read
// back as a corrupt snapshot. `writeFileAtomic` closes that hole: bytes go
// to a temp file in the same directory, the temp file is fsynced, then a
// single `rename` publishes it. Readers only ever observe the old bytes or
// the new bytes, never a half-written mix.
//
// Temp names append `.tmp.<pid>.<now>.<counter>.<rand>` to the target
// basename, so they never end in `.json` and never match
// `SNAPSHOT_FILE_PATTERN`: a temp file orphaned by a crash is invisible to
// the retention pruner and to every snapshot reader, and the next successful
// write leaves no residue. A failure at any stage removes the temp file and
// rethrows the original error, so the CLI's fail-closed messages keep their
// exact bytes.

import { open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

let tempCounter = 0;

function tempPathFor(targetPath) {
  tempCounter += 1;
  const suffix =
    `tmp.${process.pid}.${Date.now()}.${tempCounter}.${randomBytes(4).toString("hex")}`;
  return join(dirname(targetPath), `${basename(targetPath)}.${suffix}`);
}

async function fsyncDirectory(dirPath) {
  let handle = null;
  try {
    handle = await open(dirPath, "r");
    await handle.sync();
  } catch {
    // Best-effort durability: directory fsync is unsupported on some
    // platforms; the file fsync above is the real guarantee.
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Write `data` to `targetPath` atomically via temp-file + rename. `data` and
// `options.encoding` follow `fs.writeFile` conventions; set
// `options.fsync` to false to skip the pre-rename fsync (tests only — the
// CLI always fsyncs).
export async function writeFileAtomic(targetPath, data, options = {}) {
  if (typeof targetPath !== "string" || targetPath === "") {
    throw new TypeError("targetPath must be a non-empty string");
  }
  const { encoding = "utf8", fsync = true } = options ?? {};
  const tmpPath = tempPathFor(targetPath);
  let handle = null;
  try {
    handle = await open(tmpPath, "w");
    await handle.writeFile(data, encoding);
    if (fsync) {
      await handle.sync();
    }
    await handle.close();
    handle = null;
    await rename(tmpPath, targetPath);
    await fsyncDirectory(dirname(targetPath));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
