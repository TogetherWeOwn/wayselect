// TOG-6380 (Gap T2/P1): listing-index render budget assertion at the max
// limit.
//
// What: renders the listing index at LISTINGS_MAX_LIMIT (100 rows) through
// the same pure path the server uses (`paginateListings` +
// `renderListingIndex`, eligibility resolved internally) and asserts the
// wall clock stays under LISTING_INDEX_RENDER_TIME_BUDGET_MS (500ms) and
// the HTML stays under LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES (64 KiB).
// A live-route smoke pins GET /listings?limit=100 to 200 with a body under
// the same size budget on the checked-in stub catalog.
//
// Why: TOG-6036 pins select latency and TOG-6028 caps the page at 100 rows,
// but neither pins what the max-limit render costs — a render regression
// (heavier rows, an accidental unbounded slice) would ship silently. The
// budgets are deliberately generous: a 100-row render takes under 1ms and
// ~33KB, so the margins absorb CI timer variance without flaking.
//
// Verifiability: halve either budget locally and rerun — the fixed 300ms
// control delay alone exceeds a 250ms time budget, and the measured ~33KB
// exceeds a 32KiB size budget — so both assertions fail loudly.
//
// Runbook (when this trips): bisect recent listing-detail / filter /
// eligibility changes, profile `renderListingIndex` at limit=100, fix the
// regression — do NOT raise a budget without recording a perf explanation
// on the card. Distinct from TOG-6028 (window slicing) and TOG-6036
// (select latency). Test/CI-only, no prod activation.

import test from "node:test";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  LISTINGS_MAX_LIMIT,
  emptyFilters,
  paginateListings,
} from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

// Generous wall-clock budget for one max-limit index render (CI-safe).
export const LISTING_INDEX_RENDER_TIME_BUDGET_MS = 500;

// Generous size budget for one max-limit index page: ~2x the measured
// ~33KB for 100 long-named synthetic rows. Halving it to 32KiB fails
// loudly against the measured size, proving the assertion is wired up.
export const LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES = 65536;

// Fixed control delay: proves the time assertion trips (see header). Do
// NOT scale this with the budget — halving the budget must fail loudly.
const CONTROL_DELAY_MS = 300;

// Worst-case-shaped synthetic catalog: exactly LISTINGS_MAX_LIMIT rows
// with long display names, full capability/modality/cost entries (so the
// render exercises the eligibility path exactly as the server does).
function maxLimitCatalog() {
  return Array.from({ length: LISTINGS_MAX_LIMIT }, (_, i) => ({
    providerId: "synth-provider-with-a-long-name",
    providerName: "Synthetic Provider With A Reasonably Long Display Name",
    modelId: `model-${String(i).padStart(3, "0")}`,
    entry: {
      id: `model-${i}`,
      name: `Model Number ${i} With A Fairly Long Display Name For Realism`,
      attachment: true,
      reasoning: false,
      tool_call: true,
      structured_output: false,
      modalities: { input: ["text", "image"], output: ["text"] },
      cost: { input: 1.5, output: 3 },
    },
  }));
}

function liCount(html) {
  return (html.match(/<li>/g) ?? []).length;
}

test(`max-limit index render + ${CONTROL_DELAY_MS}ms control delay completes within ${LISTING_INDEX_RENDER_TIME_BUDGET_MS}ms (TOG-6380)`, async () => {
  const catalog = maxLimitCatalog();
  const { page, total, limit, offset } = paginateListings(catalog, {
    limit: LISTINGS_MAX_LIMIT,
    offset: 0,
  });
  assert.equal(page.length, LISTINGS_MAX_LIMIT);

  const start = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, CONTROL_DELAY_MS));
  const html = renderListingIndex(page, undefined, emptyFilters(), { total, limit, offset });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(liCount(html), LISTINGS_MAX_LIMIT);
  assert.ok(
    elapsedMs < LISTING_INDEX_RENDER_TIME_BUDGET_MS,
    `Index render regression: max-limit render took ${elapsedMs.toFixed(1)}ms, ` +
      `budget ${LISTING_INDEX_RENDER_TIME_BUDGET_MS}ms. Runbook: bisect ` +
      `recent listing-detail/filter/eligibility changes, profile ` +
      `renderListingIndex at limit=${LISTINGS_MAX_LIMIT}, fix the ` +
      `regression — do not raise the budget without a recorded perf ` +
      `explanation.`,
  );
});

test(`max-limit index HTML stays under ${LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES} bytes (TOG-6380)`, () => {
  const catalog = maxLimitCatalog();
  const { page, total, limit, offset } = paginateListings(catalog, {
    limit: LISTINGS_MAX_LIMIT,
    offset: 0,
  });
  const html = renderListingIndex(page, undefined, emptyFilters(), { total, limit, offset });
  const bytes = Buffer.byteLength(html, "utf8");

  assert.equal(liCount(html), LISTINGS_MAX_LIMIT);
  // Exact-full page keeps the legacy count copy (no "Showing" suffix —
  // the renderer only announces a window when slicing; see TOG-6028).
  assert.ok(
    html.includes(`${LISTINGS_MAX_LIMIT} listings found.`),
    "max-limit count announced",
  );
  assert.ok(
    bytes < LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES,
    `Index size regression: max-limit page is ${bytes} bytes, budget ` +
      `${LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES} bytes. Runbook: bisect ` +
      `recent listing-detail/filter changes for heavier rows or an ` +
      `unbounded slice — do not raise the budget without a recorded ` +
      `perf explanation.`,
  );
});

describe("max-limit index server route (TOG-6380)", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves limit=100 with a 200 and a body under the size budget", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings?limit=100`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(
      Buffer.byteLength(html, "utf8") < LISTING_INDEX_RENDER_SIZE_BUDGET_BYTES,
      "stub-catalog max-limit page bounded",
    );
  });
});
