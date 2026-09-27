import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readFixture } from "../support/helpers.js";

// TOG-6052: no-network contract for bin/check-models-dev-freshness.
// The ONLY networked call site in the probe path is globalThis.fetch inside
// fetchLiveCatalog (bin/check-models-dev-freshness), reachable solely via
// --fetch. --input must complete with zero network I/O. Contract doc:
// docs/models-dev-freshness-probe-offline-contract.md.

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

test("TOG-6052: probe source has a single network call site gated behind --fetch", async () => {
  const [binSource, probeSource] = await Promise.all([
    readFile(new URL("../bin/check-models-dev-freshness", import.meta.url), "utf8"),
    readFile(new URL("../src/modelsDevProbe.js", import.meta.url), "utf8"),
  ]);

  // Exactly one fetch call site, located inside fetchLiveCatalog ...
  const fetchCalls = binSource.match(/globalThis\.fetch\(/g) ?? [];
  assert.equal(fetchCalls.length, 1);
  const definitionAt = binSource.indexOf("async function fetchLiveCatalog");
  assert.ok(definitionAt !== -1);
  assert.ok(binSource.indexOf("globalThis.fetch(") > definitionAt);
  // ... invoked only from the --fetch branch, and --fetch/--input are
  // mutually exclusive with one required.
  assert.match(binSource, /if \(args\.fetch\) \{/);
  assert.match(binSource, /probe takes either --fetch or --input, not both/);

  // The probe library is pure computation: no imports, no network primitives.
  assert.ok(!/^import /m.test(probeSource), "modelsDevProbe.js must stay import-free");
  for (const pattern of [/fetch\(/, /node:https?/, /node:net/, /node:dns/, /child_process/]) {
    assert.ok(!pattern.test(probeSource), `modelsDevProbe.js must not match ${pattern}`);
  }
});

async function writeFetchBlocker(dir) {
  const preload = join(dir, "block-fetch.mjs");
  await writeFile(
    preload,
    'globalThis.fetch = () => { throw new Error("network access is forbidden in offline probe"); };\n',
  );
  return pathToFileURL(preload).href;
}

async function freshNowIso() {
  const fixture = await readFixture("catalog.synthetic.json");
  return new Date(Date.parse(fixture.provenance.snapshotTimestamp) + 3600000).toISOString();
}

async function writeLiveInput(dir) {
  const fixture = await readFixture("catalog.synthetic.json");
  const inputPath = join(dir, "live.json");
  await writeFile(inputPath, JSON.stringify(fixture.catalog));
  return inputPath;
}

test("TOG-6052: --input completes with fetch blocked (zero network use)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-offline-"));
  const preload = await writeFetchBlocker(dir);
  const inputPath = await writeLiveInput(dir);

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--import",
      preload,
      "bin/check-models-dev-freshness",
      "--input",
      inputPath,
      "--now",
      await freshNowIso(),
    ],
    { cwd: repoRoot },
  );
  // Any network call would throw in the preload and exit 1; exit 0 with an
  // empty stderr proves fetch was never reached.
  assert.equal(stderr, "");
  assert.match(stdout, /network not used/);
  assert.match(stdout, /freshness: fresh/);
});

test("TOG-6052: --input --json reports networkUsed false with fetch blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "probe-offline-json-"));
  const preload = await writeFetchBlocker(dir);
  const inputPath = await writeLiveInput(dir);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      preload,
      "bin/check-models-dev-freshness",
      "--input",
      inputPath,
      "--json",
      "--now",
      await freshNowIso(),
    ],
    { cwd: repoRoot },
  );
  const summary = JSON.parse(stdout);
  assert.equal(summary.networkUsed, false);
  assert.match(summary.fetchSource, /^file:\/\//);
});

test("TOG-6052: --fetch reaches the (blocked) network path and fails closed", async () => {
  // Guards the two tests above against a silently ignored --import: with
  // fetch blocked, the --fetch path must fail instead of succeeding.
  const dir = await mkdtemp(join(tmpdir(), "probe-offline-fetch-"));
  const preload = await writeFetchBlocker(dir);

  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          preload,
          "bin/check-models-dev-freshness",
          "--fetch",
          "--fetch-url",
          "https://models.dev/api.json",
        ],
        { cwd: repoRoot },
      ),
    /Cannot fetch/,
  );
});
