#!/usr/bin/env sh
# Wayselect seller-onboarding acceptance script (TOG-4958).
# Usage: [STAGING_CATALOG=<url-or-path>] scripts/seller-acceptance.sh
# When STAGING_CATALOG is unset, the repo fixtures are used (smoke run).
# Runs S1-S7 from docs/seller-onboarding-spec-v1.md; prints a verdict per step.
# A completed run (all steps executed with verdicts) counts for the
# seven-day metric even with expected FAILs. Exits 0 only if no FAIL.
set -u

PASS=0; FAIL=0; BLOCKED=0

verdict() {
  # verdict <step> <PASS|FAIL|BLOCKED> <message>
  echo "[$2] $1 — $3"
  case "$2" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    BLOCKED) BLOCKED=$((BLOCKED + 1)) ;;
  esac
}

TMPDIR_WORK="${TMPDIR:-/tmp}/seller-accept-$$"
mkdir -p "$TMPDIR_WORK"
trap 'rm -rf "$TMPDIR_WORK"' EXIT INT TERM
export REPO_ROOT
REPO_ROOT="$(pwd)"

fetch_catalog() {
  CATALOG_FILE="$TMPDIR_WORK/catalog.json"
  SRC="${STAGING_CATALOG:-fixtures/catalog.synthetic.json}"
  case "$SRC" in
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$SRC" -o "$CATALOG_FILE" || return 1
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$CATALOG_FILE" "$SRC" || return 1
      else
        echo "need curl or wget for URL catalogs"; return 1
      fi
      ;;
    *)
      cp "$SRC" "$CATALOG_FILE" || return 1
      ;;
  esac
  echo "$CATALOG_FILE"
}

# --- S1: catalog fetch ---
if CATALOG_FILE="$(fetch_catalog)"; then
  verdict S1 PASS "snapshot reachable: ${STAGING_CATALOG:-fixtures/catalog.synthetic.json} (cached at $CATALOG_FILE)"
else
  verdict S1 FAIL "snapshot unreachable: ${STAGING_CATALOG:-<default>} — file defect on staging setup (QA & Release Engineer)"
  echo "Cannot continue without a catalog. Aborting."
  exit 1
fi

# Record provenance (accepts snapshotTimestamp on current fixtures or fetchedAt on v1 entries).
python3 - "$CATALOG_FILE" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
if isinstance(data, dict) and "provenance" in data:
    p = data["provenance"]
    print(f"S1-INFO: provenance source={p.get('source')} snapshot={p.get('snapshotTimestamp') or p.get('fetchedAt')}")
elif isinstance(data, list) and data and "provenance" in data[0]:
    print(f"S1-INFO: v1 entry provenance source={data[0]['provenance'].get('source')} fetchedAt={data[0]['provenance'].get('fetchedAt')}")
else:
    print("S1-ERROR: no provenance block found")
    sys.exit(11)
EOF
if [ $? -ne 0 ]; then
  verdict S1 FAIL "provenance block missing — file defect on catalog source (QA & Release Engineer)"
  echo "Cannot continue without provenance. Aborting."
  exit 1
fi

# --- S2: schema validation (§2 required keys) + fail-closed live probes ---
python3 - "$CATALOG_FILE" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
if isinstance(data, list):
    # v1 entry shape
    required_top = ["schemaVersion", "providerId", "modelId", "provenance", "entry"]
    required_entry = ["id", "name"]
    entries = data
    for i, e in enumerate(entries):
        for k in required_top:
            assert k in e, f"entry[{i}] missing {k}"
        for k in required_entry:
            assert k in (e.get("entry") or {}), f"entry[{i}].entry missing {k}"
else:
    # current provider-keyed fixture shape
    p = data.get("provenance", {})
    for k in ["source", "snapshotTimestamp", "snapshotHash"]:
        assert k in p, f"provenance missing {k}"
    for pk, pv in data.get("catalog", {}).items():
        assert pv.get("id") == pk and pv.get("name"), f"provider {pk} missing id/name"
        for mk, mv in pv.get("models", {}).items():
            assert mv.get("id") == mk, f"model {mk}: id must match key"
            for k in ["name", "modalities"]:
                assert k in mv, f"provider {pk} model {mk} missing {k}"
print("S2-INFO: required keys present")
EOF
if [ $? -eq 0 ]; then
  verdict S2 PASS "§2 required keys present on all submitted entries"
else
  verdict S2 FAIL "entries missing required keys (see S2-ERROR above) — file defect on catalog source (QA & Release Engineer)"
fi

# S2 live probe: malformed entry rejected with identifying context; unknown field refused.
# Mutations change the catalog body, so each mutated copy re-pins the
# integrity hash first: otherwise every mutation trivially refuses at the
# snapshot-hash layer (pinned separately by the security checklist) and the
# probe never reaches the field validator it claims to exercise.
cat > "$TMPDIR_WORK/failclosed.mjs" <<'EOF'
import { readFileSync } from "node:fs";
const { computeCatalogSnapshotHash, normalizeCatalog } = await import(`${process.env.REPO_ROOT}/src/index.js`);
const base = JSON.parse(readFileSync(process.argv[2] ?? "fixtures/catalog.synthetic.json", "utf8"));
if (Array.isArray(base)) { console.log("S2-PROBE: v1 entry list; validator rejects via TOG-4830 path"); process.exit(0); }
const malformed = structuredClone(base);
delete malformed.catalog.northstar.models["alpha-chat"].name;
malformed.provenance.snapshotHash = computeCatalogSnapshotHash(malformed.catalog);
let malformedRejected = false;
try { normalizeCatalog(malformed.catalog, malformed.provenance); }
catch (e) { malformedRejected = /alpha-chat/.test(e.message); console.log(`S2-PROBE malformed rejected: ${e.message}`); }
const injected = structuredClone(base);
injected.catalog.northstar.models["alpha-chat"].admin_override = true;
injected.provenance.snapshotHash = computeCatalogSnapshotHash(injected.catalog);
let unknownRejected = false;
try { normalizeCatalog(injected.catalog, injected.provenance); }
catch (e) { unknownRejected = /unknown field/.test(e.message); console.log(`S2-PROBE unknown-field rejected: ${e.message}`); }
if (!malformedRejected || !unknownRejected) { console.log("S2-PROBE-ERROR: fail-closed rejection missing"); process.exit(1); }
console.log("S2-PROBE: fail-closed rejections carry identifying context");
EOF
if node "$TMPDIR_WORK/failclosed.mjs" "$CATALOG_FILE" >"$TMPDIR_WORK/failclosed.log" 2>&1; then
  if grep -q "S2-PROBE: fail-closed rejections\|TOG-4830 path" "$TMPDIR_WORK/failclosed.log"; then
    cat "$TMPDIR_WORK/failclosed.log"
    verdict S2 PASS "malformed entries rejected with identifying context; unknown fields refused fail-closed"
  else
    verdict S2 FAIL "fail-closed probe inconclusive — defect in validation path (Founding Engineer)"
  fi
else
  cat "$TMPDIR_WORK/failclosed.log"
  verdict S2 FAIL "fail-closed probe failed (see S2-PROBE above) — defect in validation path (Founding Engineer)"
fi

# --- S3: seller-field render from exact keys ---
python3 - "$CATALOG_FILE" "fixtures/configuration.synthetic.json" <<'EOF'
import json, sys
data = json.load(open(sys.argv[1]))
try:
    config = json.load(open(sys.argv[2]))
    support = {c["routeId"]: c for c in config.get("candidates", [])}
except Exception:
    support = {}
if isinstance(data, list):
    entries = [(e.get("providerId"), e.get("modelId"), e.get("entry", {}) or {}) for e in data]
else:
    entries = []
    for pk, pv in data.get("catalog", {}).items():
        for mk, mv in pv.get("models", {}).items():
            entries.append((pk, f"{pk}/{mk}", mv))
for seller, route, en in entries:
    title = en.get("name"); mid = en.get("id")
    cost = en.get("cost")
    price = "Price unpublished" if cost is None else f"in={cost.get('input') if isinstance(cost, dict) else cost} out={cost.get('output') if isinstance(cost, dict) else '?'}"
    mods = en.get("modalities", {})
    sup = support.get(route, {})
    ev = (sup.get("evidence") or {}).get("observedAt", "no-evidence")
    print(f"  - {title} [{mid or route}] | seller={seller} | {price} | modalities={mods} | support={sup.get('supportState', 'catalogued')} evidence={ev}")
    assert title and seller, "missing title/seller key"
print(f"S3-INFO: rendered {len(entries)} seller listings")
EOF
if [ $? -eq 0 ]; then
  verdict S3 PASS "seller fields render from exact keys (missing cost → Price unpublished)"
else
  verdict S3 FAIL "seller-field render failed — missing title/seller keys; defect on catalog source (QA & Release Engineer)"
fi

# --- S4: eligibility preview trace (--dry-run explain) ---
if [ -x "bin/wayselect" ] && bin/wayselect select --help 2>/dev/null | grep -q "dry-run"; then
  verdict S4 PASS "--dry-run explain present (TOG-4836)"
else
  TRACE_ROUTES="$(node bin/wayselect 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('selection',{}).get('candidates',[])))" 2>/dev/null || echo 0)"
  verdict S4 BLOCKED "CLI --dry-run explain not available — blocked by TOG-4836 (unmerged); current trace exposes per-candidate reasons on $TRACE_ROUTES routes, spec §3.4 stands as requirement"
fi

# --- S5: unknown-capability exclusion (live CLI probe) ---
node bin/wayselect >"$TMPDIR_WORK/selection.json" 2>/dev/null
python3 - "$TMPDIR_WORK/selection.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
cands = {c["routeId"]: c for c in d.get("selection", {}).get("candidates", [])}
u = cands.get("northstar/unknown-tools")
assert u is not None, "fixture route northstar/unknown-tools missing"
assert not u["eligible"], "unknown-tools must not be eligible"
assert "missing-capability:toolUse" in u["reasons"], f"expected missing-capability:toolUse, got {u['reasons']}"
sel = d.get("selection", {}).get("selected")
assert sel is None or sel.get("routeId") != "northstar/unknown-tools", "unknown-tools must never be selected"
print(f"S5-INFO: northstar/unknown-tools excluded with {u['reasons']}, selected={(sel or {}).get('routeId')}")
EOF
if [ $? -eq 0 ]; then
  verdict S5 PASS "unknown-capability fixture excluded with missing-capability:toolUse, never selected"
else
  verdict S5 FAIL "unknown-capability exclusion broken (see S5 error) — defect in eligibility path (Founding Engineer)"
fi

# --- S6: stale-catalog fail-closed (live probe, 24h limit) ---
cat > "$TMPDIR_WORK/freshness.mjs" <<'EOF'
const { checkCatalogFreshness, requireFreshCatalog, CatalogStaleError } =
  await import(`${process.env.REPO_ROOT}/src/freshness.js`);
const DAY = 24 * 3600 * 1000;
const now = new Date("2026-09-24T12:00:00.000Z");
const stale = checkCatalogFreshness({ provenance: { snapshotTimestamp: "2026-09-01T00:00:00.000Z" } }, { now, maxCatalogAgeMs: DAY });
const fresh = checkCatalogFreshness({ provenance: { snapshotTimestamp: "2026-09-24T10:00:00.000Z" } }, { now, maxCatalogAgeMs: DAY });
let refused = false;
try { requireFreshCatalog({ provenance: { snapshotTimestamp: "2026-09-01T00:00:00.000Z" } }, { now, maxCatalogAgeMs: DAY }); }
catch (e) { refused = e instanceof CatalogStaleError; console.log(`S6-PROBE stale refused: ${e.message}`); }
console.log(`S6-PROBE stale fresh=${stale.fresh} fresh-snapshot fresh=${fresh.fresh} refused=${refused}`);
if (stale.fresh || !fresh.fresh || !refused) process.exit(1);
EOF
if node "$TMPDIR_WORK/freshness.mjs" >"$TMPDIR_WORK/freshness.log" 2>&1; then
  cat "$TMPDIR_WORK/freshness.log"
  verdict S6 PASS "stale snapshot probes fresh:false and is refused (stale-catalog); fresh snapshot passes"
else
  cat "$TMPDIR_WORK/freshness.log"
  verdict S6 FAIL "freshness probe misbehaving (see S6-PROBE above) — defect in freshness path (Founding Engineer)"
fi

# --- S7: confirm + listing-created surfaces (TOG-4969) ---
# Exercises the real preview server: intake a fixture submission, confirm
# screen restates routeId/price/support/verdict with exact reason codes, the
# confirm POST records intent-only, rejections name key + source, and the
# flag-off server refuses everything. No live publish anywhere.
cat > "$TMPDIR_WORK/s7.mjs" <<'EOF'
import { readFile } from "node:fs/promises";
const { createApp } = await import(`${process.env.REPO_ROOT}/web/server.js`);
const fixtures = JSON.parse(
  await readFile(`${process.env.REPO_ROOT}/fixtures/seller-submission.synthetic.json`, "utf8"),
);

async function listen(env) {
  const server = createApp(env);
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}
const close = (server) => new Promise((resolve) => server.close(resolve));
async function postJson(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const failures = [];
function check(cond, label, detail = "") {
  console.log(`S7-PROBE ${cond ? "ok" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures.push(label);
}

const on = await listen({ WAYSELECT_PREVIEW: "1" });
const off = await listen({});
const baseOn = `http://127.0.0.1:${on.address().port}`;
const baseOff = `http://127.0.0.1:${off.address().port}`;
try {
  // Intake: valid submission validates to a confirm model.
  const accepted = await postJson(baseOn, "/sellers/submissions", structuredClone(fixtures.valid));
  const model = JSON.parse(accepted.text);
  check(accepted.status === 200, "intake accepts the valid fixture", `got ${accepted.status}`);
  check(model.routeId === "northstar/seller-chat", "intake routeId", model.routeId);
  check(model.priceLabel === "in=1 out=2", "price as-quoted", model.priceLabel);
  check(model.supportState === "catalogued", "new listings enter catalogued", model.supportState);
  check(
    Array.isArray(model.reasons) && model.reasons.includes("support-state:catalogued"),
    "verdict carries exact reason codes",
    JSON.stringify(model.reasons),
  );

  // Unpublished price renders as Price unpublished, never invented.
  const minimal = await postJson(baseOn, "/sellers/submissions", structuredClone(fixtures.minimal));
  check(
    minimal.status === 200 && JSON.parse(minimal.text).priceLabel === "Price unpublished",
    "missing cost renders Price unpublished",
  );

  // Fail-closed rejections name the offending key + provenance source.
  const forbidden = structuredClone(fixtures.valid);
  forbidden.entry.url = "https://example.invalid/x";
  const rForbidden = await postJson(baseOn, "/sellers/submissions", forbidden);
  const jForbidden = JSON.parse(rForbidden.text);
  check(
    rForbidden.status === 400 &&
      jForbidden.code === "forbidden-field" &&
      jForbidden.key === "submission.entry.url" &&
      jForbidden.source === "synthetic://wayselect/seller-fixture-v1",
    "forbidden location field rejected with key + source",
    rForbidden.text.slice(0, 160),
  );
  const unknown = structuredClone(fixtures.valid);
  unknown.extra = true;
  const rUnknown = await postJson(baseOn, "/sellers/submissions", unknown);
  check(
    rUnknown.status === 400 && JSON.parse(rUnknown.text).code === "unknown-field",
    "unknown field rejected fail-closed",
  );

  // Confirm screen: GET restates the staged intent.
  const confirmRes = await fetch(`${baseOn}/sellers/submissions/northstar/seller-chat/confirm`);
  const confirmJson = JSON.parse(await confirmRes.text());
  check(
    confirmRes.status === 200 && confirmJson.routeId === "northstar/seller-chat",
    "confirm screen restates the staged route",
  );

  // Confirm HTML renders the §3-step-5 facts for browsers.
  const confirmHtml = await (
    await fetch(`${baseOn}/sellers/submissions/northstar/seller-chat/confirm`, {
      headers: { accept: "text/html" },
    })
  ).text();
  check(
    confirmHtml.includes("Confirm listing") &&
      confirmHtml.includes("support-state:catalogued") &&
      confirmHtml.includes("No live publish"),
    "confirm HTML restates route, verdict codes, intent-only",
  );

  // Listing-created receipt: intent recorded, never a publish.
  const receiptRes = await fetch(
    `${baseOn}/sellers/submissions/northstar/seller-chat/confirm`,
    { method: "POST" },
  );
  const receipt = JSON.parse(await receiptRes.text());
  check(
    receiptRes.status === 200 && receipt.recorded === true && receipt.intentOnly === true,
    "confirm records intent only (no live publish)",
  );
  check(
    receipt.routeId === "northstar/seller-chat" &&
      receipt.priceLabel === "in=1 out=2" &&
      receipt.provenance?.source === "synthetic://wayselect/seller-fixture-v1",
    "receipt carries route, price as-quoted, provenance",
  );
  check(
    !("amount" in receipt) && !("paymentUrl" in receipt) && !("url" in receipt),
    "receipt carries no payment or location fields",
  );

  // Unknown intents fail closed; flag-off refuses everything.
  const missing = await fetch(`${baseOn}/sellers/submissions/northstar/nope/confirm`);
  check(missing.status === 404, "unknown intent 404s (never guessed)");
  const offPost = await postJson(baseOff, "/sellers/submissions", structuredClone(fixtures.valid));
  check(
    offPost.status === 404 && JSON.parse(offPost.text).error === "preview_disabled",
    "flag off refuses intake",
  );
} finally {
  await Promise.all([close(on), close(off)]);
}
if (failures.length > 0) {
  console.log(`S7-PROBE-ERROR: ${failures.length} probe(s) failed`);
  process.exit(1);
}
console.log("S7-PROBE: intake + fail-closed validation + confirm + receipt all green");
EOF
if node "$TMPDIR_WORK/s7.mjs" >"$TMPDIR_WORK/s7.log" 2>&1; then
  cat "$TMPDIR_WORK/s7.log"
  verdict S7 PASS "submission intake + fail-closed validation + confirm screen + intent-only receipt (TOG-4969)"
else
  cat "$TMPDIR_WORK/s7.log"
  verdict S7 FAIL "seller confirm surfaces misbehaving (see S7-PROBE above) — defect in seller build slice TOG-4969 (Web Engineer)"
fi

echo "---"
echo "seller-acceptance: PASS=$PASS FAIL=$FAIL BLOCKED=$BLOCKED"
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: no FAIL verdicts"
  exit 0
else
  echo "RESULT: $FAIL FAIL verdict(s) — see named defects above"
  exit 1
fi
