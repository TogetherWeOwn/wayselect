// Tests for the TOG-5221 catalog eligibility display slice: per-model
// granted / blocked / unknown states over existing capability-check output
// (web/eligibility.js consuming src/eligibility.js), rendered distinctly in
// the catalog surface with fail-closed copy on unknown (node:test, stdlib +
// repo modules only).

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  ELIGIBILITY_STATE,
  PREVIEW_ELIGIBILITY_REQUEST,
  candidateFromStubListing,
  classifyEligibilityDisplay,
  describeEligibility,
  evaluateListingEligibility,
  evaluateListingsEligibility,
} from "../web/eligibility.js";
import { getStubListing, STUB_LISTINGS } from "../web/stub-listing.js";
import {
  renderListingDetail,
  renderListingIndex,
} from "../web/listing-detail.js";
import { createApp } from "../web/server.js";

describe("eligibility classification", () => {
  it("maps granted, blocked, and unknown to three distinct states", () => {
    strictEqual(
      classifyEligibilityDisplay({ eligible: true, reasons: [] }),
      ELIGIBILITY_STATE.GRANTED,
    );
    strictEqual(
      classifyEligibilityDisplay({
        eligible: false,
        reasons: ["operation-not-configured", "provider-not-allowed"],
      }),
      ELIGIBILITY_STATE.BLOCKED,
    );
    strictEqual(
      classifyEligibilityDisplay({
        eligible: false,
        reasons: ["missing-capability:toolUse"],
      }),
      ELIGIBILITY_STATE.UNKNOWN,
    );
  });

  it("fails closed to unknown on malformed or empty evaluations", () => {
    for (const malformed of [
      null,
      undefined,
      "granted",
      [],
      {},
      { eligible: true, reasons: null },
      { eligible: "yes", reasons: [] },
      // Ineligible with no reasons contradicts the evaluator contract.
      { eligible: false, reasons: [] },
      { eligible: false, reasons: [42] },
    ]) {
      strictEqual(
        classifyEligibilityDisplay(malformed),
        ELIGIBILITY_STATE.UNKNOWN,
        JSON.stringify(malformed),
      );
    }
  });

  it("treats missing/invalid/stale evidence and catalog signals as unknown", () => {
    for (const reason of [
      "missing-evidence",
      "invalid-evidence",
      "future-evidence",
      "stale-evidence",
      "stale-catalog",
      "future-catalog",
      "missing-capability:unpublishedCapability",
    ]) {
      strictEqual(
        classifyEligibilityDisplay({ eligible: false, reasons: [reason] }),
        ELIGIBILITY_STATE.UNKNOWN,
        reason,
      );
    }
  });

  it("keeps support-state exclusions as blocked, not unknown", () => {
    strictEqual(
      classifyEligibilityDisplay({
        eligible: false,
        reasons: ["support-state:unsupported"],
      }),
      ELIGIBILITY_STATE.BLOCKED,
    );
  });
});

describe("stub listing evaluations (existing capability-check output)", () => {
  it("evaluates alpha-chat as granted under the frozen preview request", () => {
    const evaluation = evaluateListingEligibility(getStubListing("northstar", "alpha-chat"));
    strictEqual(evaluation.eligible, true);
    deepStrictEqual([...evaluation.reasons], []);
    strictEqual(classifyEligibilityDisplay(evaluation), ELIGIBILITY_STATE.GRANTED);
  });

  it("evaluates image-lite as blocked (wrong operation for the preview check)", () => {
    const evaluation = evaluateListingEligibility(getStubListing("northstar", "image-lite"));
    strictEqual(evaluation.eligible, false);
    strictEqual(classifyEligibilityDisplay(evaluation), ELIGIBILITY_STATE.BLOCKED);
    ok(evaluation.reasons.includes("operation-not-configured"));
  });

  it("evaluates unknown-tools as unknown (missing capability data fails closed)", () => {
    const evaluation = evaluateListingEligibility(
      getStubListing("northstar", "unknown-tools"),
    );
    strictEqual(evaluation.eligible, false);
    strictEqual(classifyEligibilityDisplay(evaluation), ELIGIBILITY_STATE.UNKNOWN);
    ok(evaluation.reasons.includes("missing-capability:toolUse"));
  });

  it("maps null capability flags to null candidates without guessing", () => {
    const candidate = candidateFromStubListing(getStubListing("northstar", "unknown-tools"));
    strictEqual(candidate.capabilities.toolUse, null);
    strictEqual(candidate.capabilities.attachment, null);
  });

  it("uses the same frozen request the demo fixtures document", () => {
    deepStrictEqual(
      { ...PREVIEW_ELIGIBILITY_REQUEST },
      {
        operation: "chat",
        requiredCapabilities: ["toolUse"],
        providerAllowlist: ["northstar", "orbit"],
      },
    );
  });
});

describe("eligibility copy (fail-closed text on unknown)", () => {
  it("unknown copy says not selectable until capability data is available", () => {
    const described = describeEligibility({
      eligible: false,
      reasons: ["missing-capability:toolUse"],
    });
    strictEqual(described.state, ELIGIBILITY_STATE.UNKNOWN);
    strictEqual(described.label, "Unknown");
    ok(described.headline.includes("not selectable"));
    ok(described.headline.includes("capability data"));
  });

  it("granted and blocked copy name the preview capability check", () => {
    const granted = describeEligibility({ eligible: true, reasons: [] });
    strictEqual(granted.label, "Granted");
    ok(granted.headline.includes("preview capability check"));
    const blocked = describeEligibility({
      eligible: false,
      reasons: ["operation-not-configured"],
    });
    strictEqual(blocked.label, "Blocked");
    ok(blocked.headline.includes("preview capability check"));
  });
});

describe("catalog surface rendering", () => {
  it("renders the three states distinctly on the detail page", () => {
    const granted = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    ok(granted.includes("badge-granted"), "granted badge class");
    ok(granted.includes('aria-label="eligibility: granted"'));
    ok(granted.includes("Granted"));

    const blocked = renderListingDetail(getStubListing("northstar", "image-lite"));
    ok(blocked.includes("badge-blocked"), "blocked badge class");
    ok(blocked.includes('aria-label="eligibility: blocked"'));
    ok(blocked.includes("Blocked"));
    ok(blocked.includes("operation-not-configured"));

    const unknown = renderListingDetail(getStubListing("northstar", "unknown-tools"));
    ok(unknown.includes("badge-unknown"), "unknown badge class");
    ok(unknown.includes('aria-label="eligibility: unknown"'));
    ok(unknown.includes("Unknown"));
    ok(unknown.includes("not selectable"));
    ok(unknown.includes("missing-capability:toolUse"));
  });

  it("renders missing capability fields as Unknown rows, never as Yes", () => {
    const html = renderListingDetail(getStubListing("northstar", "unknown-tools"));
    ok(html.includes("capability unknown"));
    ok(!html.includes("<h1>Unknown Tools</h1>") || html.includes("Unknown Tools"));
    // No Yes badge may appear for a listing with no capability data.
    ok(!html.includes('aria-label="supported"'), "no supported badge for unknown data");
  });

  it("renders per-model badges on the index page", () => {
    const html = renderListingIndex(STUB_LISTINGS);
    ok(html.includes("badge-granted"), "index has a granted badge");
    ok(html.includes("badge-blocked"), "index has a blocked badge");
    ok(html.includes("badge-unknown"), "index has an unknown badge");
    ok(html.includes("Unknown Tools"), "index lists the unknown-data stub");
  });

  it("degrades to unknown instead of throwing on evaluation failure", () => {
    // Explicit null evaluation (evaluator threw or returned nothing): the
    // section fails closed to unknown.
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"), null);
    ok(html.includes("badge-unknown"));
    ok(html.includes("not selectable"));
    const index = renderListingIndex(
      [getStubListing("northstar", "alpha-chat")],
      new Map(),
    );
    ok(index.includes("badge-unknown"));
  });

  it("renders listings with missing modalities/cost without crashing", () => {
    const sparse = {
      providerId: "northstar",
      providerName: "Northstar Synthetic Provider",
      modelId: "unknown-tools",
      entry: { id: "unknown-tools", name: "Unknown Tools" },
    };
    const html = renderListingDetail(sparse);
    ok(html.includes("badge-unknown"));
    ok(html.includes("not selectable"));
    ok(html.includes("capability unknown"));
  });

  it("escapes untrusted eligibility reasons", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"), {
      eligible: false,
      reasons: ['<script>alert(1)</script>'],
    });
    ok(!html.includes("<script>alert(1)</script>"));
    ok(html.includes("&lt;script&gt;"));
  });
});

describe("preview server with eligibility display", () => {
  const servers = [];
  async function start(env) {
    const server = createApp(env);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, resolve));
    return `http://localhost:${server.address().port}`;
  }
  after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

  it("serves detail pages with eligibility sections for all three states", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    for (const [route, badge] of [
      ["northstar/alpha-chat", "badge-granted"],
      ["northstar/image-lite", "badge-blocked"],
      ["northstar/unknown-tools", "badge-unknown"],
    ]) {
      const res = await fetch(`${base}/listings/${route}`);
      strictEqual(res.status, 200, route);
      const html = await res.text();
      ok(html.includes("Eligibility"), `${route} eligibility section`);
      ok(html.includes(badge), `${route} ${badge}`);
    }
  });

  it("serves the index with per-model eligibility badges", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings`);
    strictEqual(res.status, 200);
    const html = await res.text();
    ok(html.includes("badge-granted"));
    ok(html.includes("badge-blocked"));
    ok(html.includes("badge-unknown"));
  });

  it("keeps the purchase stub refused and the flag gate intact", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const res = await fetch(`${base}/listings/northstar/unknown-tools/purchase`, {
      method: "POST",
    });
    strictEqual(res.status, 403);
    deepStrictEqual(await res.json(), {
      error: "preview_only",
      message: "Purchases are disabled in preview. No backend writes.",
    });
    const off = await start({});
    strictEqual((await fetch(`${off}/listings/northstar/unknown-tools`)).status, 404);
  });

  it("evaluates every stub listing without throwing", () => {
    const byRoute = evaluateListingsEligibility(STUB_LISTINGS);
    strictEqual(byRoute.size, STUB_LISTINGS.length);
    for (const listing of STUB_LISTINGS) {
      ok(byRoute.has(`${listing.providerId}/${listing.modelId}`));
    }
  });
});
