import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { evaluationNow, readFixture } from "../support/helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

// Refresh-proof clocks: derived from the live fixture snapshot so provenance
// refreshes never break these tests. Every offset below stays inside the 72h
// evidence window (freshest observedAt is 22h behind the snapshot) so the gate
// under test is the catalog freshness gate, not evidence staleness.
async function snapshotMs() {
  const catalog = await readFixture("catalog.synthetic.json");
  return Date.parse(catalog.provenance.snapshotTimestamp);
}

async function staleEvaluationTime() {
  return new Date((await snapshotMs()) + DAY_MS + 1000).toISOString();
}

async function futureEvaluationTime() {
  return new Date((await snapshotMs()) - 1000).toISOString();
}

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
  const catalogFixture = JSON.parse(catalogRaw);
  staleRequest.evaluationTime = new Date(
    Date.parse(catalogFixture.provenance.snapshotTimestamp) + 4 * DAY_MS,
  ).toISOString();

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

// TOG-4951 HIGH-2: bin/wayselect used to call selectRoute without the
// catalog/maxCatalogAgeMs options, silently skipping the stale/future-catalog
// fail-closed gate. These tests prove the demo path wires the gate: a stale or
// future-dated catalog snapshot must yield no-eligible-route (never a
// selection), while the default request's 24h override keeps the fresh fixture
// green. Catalog provenance.snapshotTimestamp stays valid ISO throughout; only
// evaluationTime moves, and every offset below (derived from the live
// snapshot) stays inside the 72h evidence window (freshest observedAt is 22h
// behind the snapshot) so the gate under test is the catalog freshness gate,
// not evidence staleness.
async function runDemoWithRequest(requestOverrides = {}, catalogOverrides = {}) {
  const workDir = await fs.mkdtemp(join(tmpdir(), "wayselect-cli-"));
  try {
    const baseRequest = await readFixture("request.synthetic.json");
    await fs.writeFile(
      join(workDir, "request.json"),
      JSON.stringify({ ...baseRequest, ...requestOverrides }),
    );
    let catalogPath = "fixtures/catalog.synthetic.json";
    if (Object.keys(catalogOverrides).length > 0) {
      const baseCatalog = await readFixture("catalog.synthetic.json");
      await fs.writeFile(
        join(workDir, "catalog.json"),
        JSON.stringify({
          ...baseCatalog,
          provenance: { ...baseCatalog.provenance, ...catalogOverrides },
        }),
      );
      catalogPath = join(workDir, "catalog.json");
    }
    return await execFileAsync(
      process.execPath,
      [
        "bin/wayselect",
        "--catalog",
        catalogPath,
        "--configuration",
        "fixtures/configuration.synthetic.json",
        "--request",
        join(workDir, "request.json"),
      ],
      { cwd: repoRoot },
    );
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

test("fixture CLI wires the catalog gate: stale snapshot selects no route", async () => {
  // Snapshot + 24h limit + 1s => stale; inside the 72h evidence window.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await staleEvaluationTime(),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.ok(result.selection.candidates.length > 0);
  assert.ok(
    result.selection.candidates.every((candidate) =>
      candidate.reasons.includes("stale-catalog"),
    ),
  );
});

test("fixture CLI wires the catalog gate: future snapshot selects no route", async () => {
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await futureEvaluationTime(),
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "no-eligible-route");
  assert.equal(result.selection.selected, null);
  assert.ok(
    result.selection.candidates.every((candidate) =>
      candidate.reasons.includes("future-catalog"),
    ),
  );
});

test("fixture CLI honors an explicit wider maxCatalogAgeHours override", async () => {
  // Same stale timestamp as above, but a 48h window keeps the snapshot fresh.
  // Evidence: evaluationTime (snapshot + 24h1s) minus freshest observedAt
  // (snapshot - 22h) = ~46h < 72h.
  const { stdout } = await runDemoWithRequest({
    evaluationTime: await staleEvaluationTime(),
    maxCatalogAgeHours: 48,
  });
  const result = JSON.parse(stdout);

  assert.equal(result.selection.status, "selected");
  assert.equal(result.selection.selected.routeId, "northstar/alpha-chat");
});

// ---------------------------------------------------------------------------
// select/explain UX (TOG-4797). Subcommand surface; the bare-invocation demo
// tests above are unchanged.
// ---------------------------------------------------------------------------

const CLI = ["bin/wayselect"];
// Refresh-proof clock: snapshot + 2h keeps the catalog fresh and the evidence
// inside its 72h window, mirroring the checked-in request fixture.
const EVAL_ISO = evaluationNow().toISOString();
const FIXTURE_INPUT = [
  "--operation",
  "chat",
  "--require",
  "toolUse",
  "--allow",
  "northstar,orbit",
  "--evaluation-time",
  EVAL_ISO,
];

async function runCli(args, { expectFailure = false } = {}) {
  const cwd = new URL("..", import.meta.url);
  if (expectFailure) {
    try {
      await execFileAsync(process.execPath, [...CLI, ...args], { cwd });
    } catch (error) {
      return {
        code: error.code,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
      };
    }
    assert.fail(`expected CLI to fail for args: ${args.join(" ")}`);
  }
  const { stdout, stderr } = await execFileAsync(process.execPath, [...CLI, ...args], {
    cwd,
  });
  return { code: 0, stdout, stderr };
}

test("select prints the selected route and ranked exclusion reasons", async () => {
  const { stdout, stderr } = await runCli(["select", ...FIXTURE_INPUT]);

  assert.equal(stderr, "");
  assert.match(stdout, /dry-run \/ synthetic estimate/);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
  assert.match(stdout, /1\. northstar\/alpha-chat — eligible/);
  assert.match(stdout, /2\. orbit\/orbit-chat — eligible/);
  assert.match(
    stdout,
    /legacy\/old-chat — excluded \(provider-not-allowed, stale-evidence\)/,
  );
  assert.match(stdout, /missing-capability:toolUse/);
  assert.match(stdout, /support-state:unsupported/);
});

test("select --json emits the machine-readable shape", async () => {
  const { stdout, stderr } = await runCli(["select", ...FIXTURE_INPUT, "--json"]);
  const result = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(result.command, "select");
  assert.equal(result.dryRun, true);
  assert.match(result.dryRunLabel, /dry-run/);
  assert.equal(result.status, "selected");
  assert.equal(result.selectedRouteId, "northstar/alpha-chat");
  assert.equal(result.policy, "lowest-synthetic-estimated-rate-then-lexicographic-route-id");
  assert.match(result.rateDisclaimer, /not actual cost or savings/);
  assert.equal(result.evaluationTime, EVAL_ISO);
  assert.equal(result.maxEvidenceAgeHours, 72);
  assert.ok(Array.isArray(result.rankedCandidates));
  assert.equal(result.rankedCandidates.length, 6);
  assert.deepEqual(
    result.rankedCandidates.map((candidate) => candidate.rank),
    [1, 2, 3, 4, 5, 6],
  );
  const [first, excluded] = [result.rankedCandidates[0], result.rankedCandidates[2]];
  assert.equal(first.routeId, "northstar/alpha-chat");
  assert.equal(first.eligible, true);
  assert.equal(first.estimatedRatePerMillion, 3);
  assert.deepEqual(first.reasons, []);
  assert.equal(excluded.eligible, false);
  assert.ok(excluded.reasons.length > 0);
});

test("explain details every candidate with reasons and a verdict", async () => {
  const { stdout, stderr } = await runCli(["explain", ...FIXTURE_INPUT]);

  assert.equal(stderr, "");
  assert.match(stdout, /dry-run explain/);
  assert.match(stdout, /Request: operation=chat, require=\[toolUse\], allow=\[northstar, orbit\]/);
  assert.match(stdout, /northstar\/alpha-chat: eligible/);
  assert.match(stdout, /legacy\/old-chat: excluded/);
  assert.match(stdout, /- provider-not-allowed/);
  assert.match(stdout, /- stale-evidence/);
  assert.match(stdout, /verdict: selected northstar\/alpha-chat/);
});

test("explain --json uses the same machine shape under the explain command", async () => {
  const { stdout } = await runCli(["explain", ...FIXTURE_INPUT, "--json"]);
  const result = JSON.parse(stdout);

  assert.equal(result.command, "explain");
  assert.equal(result.selectedRouteId, "northstar/alpha-chat");
  assert.equal(result.rankedCandidates.length, 6);
});

test("select reads defaults from the demo request fixture", async () => {
  const { stdout } = await runCli(["select"]);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
});

test("select with a bare selection request file resolves requirements from it", async () => {
  const { stdout } = await runCli([
    "select",
    "--request",
    "fixtures/request.synthetic.json",
  ]);
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
});

test("no eligible route still prints output and exits 3", async () => {
  const { code, stdout, stderr } = await runCli(
    [
      "select",
      "--operation",
      "chat",
      "--require",
      "vision",
      "--allow",
      "northstar",
      "--evaluation-time",
      EVAL_ISO,
    ],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  assert.equal(stderr, "");
  assert.match(stdout, /No eligible route/);
  assert.match(stdout, /missing-capability:vision/);
});

test("missing request input exits 1 with guidance", async () => {
  const { code, stderr } = await runCli(["select", "--operation", "chat"], {
    expectFailure: true,
  });

  assert.equal(code, 1);
  assert.match(stderr, /provider allowlist is required/);
});

test("unknown subcommand exits 2", async () => {
  const { code, stderr } = await runCli(["frobnicate"], { expectFailure: true });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Unknown subcommand/);
});

test("unknown flag exits 2", async () => {
  const { code, stderr } = await runCli(["select", ...FIXTURE_INPUT, "--nope"], {
    expectFailure: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Unknown flag for select/);
});

test("missing flag value exits 2", async () => {
  const { code, stderr } = await runCli(["select", "--operation"], {
    expectFailure: true,
  });

  assert.equal(code, 2);
  assert.match(stderr, /usage error: Missing value for --operation/);
});

test("unreadable request file exits 1", async () => {
  const { code, stderr } = await runCli(["select", "--request", "fixtures/missing.json"], {
    expectFailure: true,
  });

  assert.equal(code, 1);
  assert.match(stderr, /Cannot read fixtures\/missing\.json/);
});

test("--help exits 0 with usage and exit codes", async () => {
  const { stdout, stderr } = await runCli(["--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /wayselect select \[options\]/);
  assert.match(stdout, /wayselect explain \[options\]/);
  assert.match(stdout, /wayselect catalog import/);
  assert.match(stdout, /Exit codes:/);
});

test("select --help exits 0 with command usage", async () => {
  const { stdout } = await runCli(["select", "--help"]);

  assert.match(stdout, /wayselect select/);
  assert.match(stdout, /Exit codes: 0 selected/);
});

test("--version exits 0 with the package version", async () => {
  const { stdout, stderr } = await runCli(["--version"]);

  assert.equal(stderr, "");
  assert.match(stdout, /^wayselect \d+\.\d+\.\d+\n$/);
});

// TOG-4791: the `catalog import` opt-in path is covered against small
// newly-authored temp-dir fixtures only — no redistributed snapshot, no
// network (--fetch is never exercised).
function importInput() {
  return {
    acme: {
      id: "acme",
      name: "Acme Synthetic",
      models: {
        "chat-one": {
          id: "chat-one",
          name: "Chat One",
          attachment: false,
          reasoning: false,
          tool_call: true,
          structured_output: true,
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 1, output: 2 },
          limit: { context: 8000, output: 2000 },
        },
        mystery: {
          id: "mystery",
          name: "Mystery",
          modalities: { input: ["text"], output: ["text"] },
          frobnicate: true,
        },
      },
    },
  };
}

async function writeImportInput(dir) {
  const path = join(dir, "models-dev-sample.json");
  await writeFile(path, JSON.stringify(importInput()));
  return path;
}

test("catalog import reads a local file, quarantines unknowns, exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const input = await writeImportInput(dir);

    const { code, stdout, stderr } = await runCli([
      "catalog",
      "import",
      input,
      "--source",
      "https://models.dev/api.json",
      "--snapshot-timestamp",
      "2026-09-24T10:00:00.000Z",
    ]);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /support state: catalogued only/);
    assert.match(stdout, /Source: https:\/\/models\.dev\/api\.json @ 2026-09-24T10:00:00\.000Z/);
    assert.match(stdout, /Snapshot hash: sha256:[a-f0-9]{64}/);
    assert.match(stdout, /Raw input hash: sha256:[a-f0-9]{64}/);
    assert.match(stdout, /Ingested 1 entry from 1 provider/);
    assert.match(stdout, /Quarantined 1:/);
    assert.match(stdout, /acme\/mystery: .*unknown field: frobnicate/);
    assert.match(stdout, /catalog document not written/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog import --json emits the machine-readable summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const input = await writeImportInput(dir);

    const { code, stdout, stderr } = await runCli([
      "catalog",
      "import",
      input,
      "--source",
      "https://models.dev/api.json",
      "--snapshot-timestamp",
      "2026-09-24T10:00:00.000Z",
      "--json",
    ]);
    const result = JSON.parse(stdout);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.equal(result.command, "catalog import");
    assert.equal(result.dryRun, true);
    assert.equal(result.networkUsed, false);
    assert.equal(result.source, "https://models.dev/api.json");
    assert.equal(result.entryCount, 1);
    assert.equal(result.providerCount, 1);
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined[0].routeId, "acme/mystery");
    assert.equal(result.outPath, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog import --out writes a verifiable catalog document", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const input = await writeImportInput(dir);
    const outPath = join(dir, "catalog.out.json");

    const { code, stdout } = await runCli([
      "catalog",
      "import",
      input,
      "--source",
      "https://models.dev/api.json",
      "--snapshot-timestamp",
      "2026-09-24T10:00:00.000Z",
      "--out",
      outPath,
    ]);
    const document = JSON.parse(await readFile(outPath, "utf8"));

    assert.equal(code, 0);
    assert.match(stdout, /Wrote catalog document:/);
    assert.equal(document.provenance.source, "https://models.dev/api.json");
    assert.deepEqual(Object.keys(document.catalog), ["acme"]);
    assert.deepEqual(Object.keys(document.catalog.acme.models), ["chat-one"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog import --snapshot-hash pins the ingested body or fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const input = await writeImportInput(dir);
    const base = [
      "catalog",
      "import",
      input,
      "--source",
      "https://models.dev/api.json",
      "--snapshot-timestamp",
      "2026-09-24T10:00:00.000Z",
      "--json",
    ];

    const first = await runCli(base);
    assert.equal(first.code, 0);
    const pinned = JSON.parse(first.stdout).snapshotHash;

    const repinned = await runCli([...base, "--snapshot-hash", pinned]);
    assert.equal(repinned.code, 0);
    assert.equal(JSON.parse(repinned.stdout).snapshotHash, pinned);

    const tampered = await runCli(
      [...base, "--snapshot-hash", `sha256:${"b".repeat(64)}`],
      { expectFailure: true },
    );
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /does not match the ingested catalog body/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog import rejects file+--fetch together and missing input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const input = await writeImportInput(dir);

    const both = await runCli(["catalog", "import", input, "--fetch"], {
      expectFailure: true,
    });
    assert.equal(both.code, 1);
    assert.match(both.stderr, /either a file or --fetch/);

    const missing = await runCli(["catalog", "import"], { expectFailure: true });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /input file or --fetch/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog import fails closed on bad JSON, unreadable files, unknown flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-import-"));
  try {
    const badJson = join(dir, "bad.json");
    await writeFile(badJson, "{not json");

    const unparsable = await runCli(["catalog", "import", badJson], {
      expectFailure: true,
    });
    assert.equal(unparsable.code, 1);
    assert.match(unparsable.stderr, /Cannot parse .* as JSON/);

    const unreadable = await runCli(["catalog", "import", join(dir, "missing.json")], {
      expectFailure: true,
    });
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stderr, /Cannot read .*missing\.json/);

    const input = await writeImportInput(dir);
    const unknownFlag = await runCli(["catalog", "import", input, "--nope"], {
      expectFailure: true,
    });
    assert.equal(unknownFlag.code, 1);
    assert.match(unknownFlag.stderr, /Unknown argument: --nope/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("catalog --help exits 0 with import usage", async () => {
  const { code, stdout, stderr } = await runCli(["catalog", "--help"]);

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /wayselect catalog import/);
  assert.match(stdout, /--fetch/);
});

// ---------------------------------------------------------------------------
// TOG-5857 (S1): typed-requirement flags on select/explain — match,
// non-match exclusion, and unknown-data fail-closed, via flags or a request
// file. Fixture-only, no network. The library filter itself landed under
// TOG-4794 (test/capability-requirements.test.js); these tests pin the CLI
// wiring that makes `select` actually capability-aware (spec R1, R2).
// ---------------------------------------------------------------------------

test("select with modality flags selects the matching route", async () => {
  const { code, stdout, stderr } = await runCli([
    "select",
    "--operation",
    "vision-chat",
    "--allow",
    "northstar",
    "--input-modalities",
    "image",
    "--output-modalities",
    "text",
    "--evaluation-time",
    EVAL_ISO,
  ]);

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Selected route: northstar\/image-lite/);
});

test("select with an unmet modality excludes every candidate and exits 3", async () => {
  const { code, stdout, stderr } = await runCli(
    [
      "select",
      "--operation",
      "chat",
      "--require",
      "toolUse",
      "--allow",
      "northstar,orbit",
      "--input-modalities",
      "audio",
      "--evaluation-time",
      EVAL_ISO,
    ],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  assert.equal(stderr, "");
  assert.match(stdout, /No eligible route/);
  assert.match(stdout, /missing-modality:input:audio/);
});

test("select with an unsatisfiable context window fails closed on unknown limits", async () => {
  // The pinned fixture carries no context_window fields, so every candidate
  // must be excluded with missing-capability:contextWindow — never selected.
  const { code, stdout } = await runCli(
    [
      "select",
      "--operation",
      "chat",
      "--require",
      "toolUse",
      "--allow",
      "northstar,orbit",
      "--min-context-window",
      "10000000",
      "--evaluation-time",
      EVAL_ISO,
      "--json",
    ],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "no-eligible-route");
  assert.equal(result.request.requirements.minContextWindow, 10000000);
  assert.ok(result.rankedCandidates.length > 0);
  for (const candidate of result.rankedCandidates) {
    assert.equal(candidate.eligible, false);
    assert.ok(
      candidate.reasons.includes("missing-capability:contextWindow"),
      `${candidate.routeId} must fail closed on unknown limits`,
    );
  }
});

test("select with max-output-tokens fails closed on unknown limits", async () => {
  const { code, stdout } = await runCli(
    [
      "select",
      "--operation",
      "chat",
      "--allow",
      "northstar,orbit",
      "--max-output-tokens",
      "2000",
      "--evaluation-time",
      EVAL_ISO,
      "--json",
    ],
    { expectFailure: true },
  );

  assert.equal(code, 3);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "no-eligible-route");
  assert.ok(
    result.rankedCandidates.every((candidate) =>
      candidate.reasons.includes("missing-capability:maxOutputTokens"),
    ),
  );
});

test("select --require-tools keeps the tool-capable route, excludes unknown data", async () => {
  const { code, stdout, stderr } = await runCli([
    "select",
    "--operation",
    "chat",
    "--allow",
    "northstar,orbit",
    "--require-tools",
    "--evaluation-time",
    EVAL_ISO,
  ]);

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Selected route: northstar\/alpha-chat/);
  assert.match(stdout, /unknown-tools — excluded \(missing-capability:toolUse\)/);
});

test("select --require-reasoning selects the reasoning route explicitly", async () => {
  const { code, stdout } = await runCli([
    "select",
    "--operation",
    "chat",
    "--allow",
    "northstar,orbit",
    "--require-reasoning",
    "--evaluation-time",
    EVAL_ISO,
  ]);

  assert.equal(code, 0);
  assert.match(stdout, /Selected route: orbit\/orbit-chat/);
  assert.match(stdout, /unsupported-capability:reasoning/);
});

test("select with a malformed threshold exits 1 without selecting", async () => {
  const { code, stdout, stderr } = await runCli(
    [
      "select",
      "--operation",
      "chat",
      "--allow",
      "northstar",
      "--min-context-window",
      "banana",
      "--evaluation-time",
      EVAL_ISO,
    ],
    { expectFailure: true },
  );

  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /--min-context-window must be a non-negative integer/);
});

test("select reads typed requirements from a request file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-s1-"));
  try {
    const requestPath = await writeTempJson(dir, "request.json", {
      operation: "vision-chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
      requirements: { inputModalities: ["image"], outputModalities: ["text"] },
    });
    const { code, stdout } = await runCli([
      "select",
      "--request",
      requestPath,
      "--catalog",
      "fixtures/catalog.synthetic.json",
      "--configuration",
      "fixtures/configuration.synthetic.json",
      "--evaluation-time",
      EVAL_ISO,
    ]);

    assert.equal(code, 0);
    assert.match(stdout, /Selected route: northstar\/image-lite/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("select flags override file requirements per dimension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-s1-"));
  try {
    const requestPath = await writeTempJson(dir, "request.json", {
      operation: "vision-chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
      requirements: { inputModalities: ["image"], outputModalities: ["text"] },
    });
    const { code, stdout } = await runCli(
      [
        "select",
        "--request",
        requestPath,
        "--catalog",
        "fixtures/catalog.synthetic.json",
        "--configuration",
        "fixtures/configuration.synthetic.json",
        "--input-modalities",
        "audio",
        "--evaluation-time",
        EVAL_ISO,
      ],
      { expectFailure: true },
    );

    assert.equal(code, 3);
    assert.match(stdout, /No eligible route/);
    assert.match(stdout, /missing-modality:input:audio/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("select rejects unknown requirements in a request file with exit 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wayselect-s1-"));
  try {
    const requestPath = await writeTempJson(dir, "request.json", {
      operation: "chat",
      requiredCapabilities: [],
      providerAllowlist: ["northstar"],
      requirements: { bogusDimension: true },
    });
    const { code, stdout, stderr } = await runCli(
      [
        "select",
        "--request",
        requestPath,
        "--catalog",
        "fixtures/catalog.synthetic.json",
        "--configuration",
        "fixtures/configuration.synthetic.json",
        "--evaluation-time",
        EVAL_ISO,
      ],
      { expectFailure: true },
    );

    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /request\.requirements contains unknown requirement: bogusDimension/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("select --help lists every typed-requirement flag", async () => {
  const { code, stdout } = await runCli(["select", "--help"]);

  assert.equal(code, 0);
  for (const flag of [
    "--input-modalities",
    "--output-modalities",
    "--min-context-window",
    "--max-output-tokens",
    "--require-tools",
    "--require-structured-output",
    "--require-reasoning",
  ]) {
    assert.ok(stdout.includes(flag), `help must list ${flag}`);
  }
});

test("explain names the typed requirements on its Request line", async () => {
  const { code, stdout } = await runCli([
    "explain",
    "--operation",
    "chat",
    "--allow",
    "northstar,orbit",
    "--require-tools",
    "--input-modalities",
    "text",
    "--evaluation-time",
    EVAL_ISO,
  ]);

  assert.equal(code, 0);
  assert.match(
    stdout,
    /Request: operation=chat, require=\[\], allow=\[northstar, orbit\], typed=\[inputModalities=\[text\], toolCalling\]/,
  );
});

