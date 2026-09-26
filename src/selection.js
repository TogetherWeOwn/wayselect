import { buildEligibilityTrace, normalizeSelectionRequest } from "./eligibility.js";

function estimatedRate(candidate) {
  if (!candidate.rates) {
    return Number.POSITIVE_INFINITY;
  }
  return candidate.rates.inputPerMillion + candidate.rates.outputPerMillion;
}

function compareEligible(left, right) {
  const rateDifference = estimatedRate(left) - estimatedRate(right);
  if (Number.isFinite(rateDifference) && rateDifference !== 0) {
    return rateDifference;
  }
  if (left.rates && !right.rates) {
    return -1;
  }
  if (!left.rates && right.rates) {
    return 1;
  }
  return left.routeId.localeCompare(right.routeId);
}

export function selectRoute(candidates, requestInput, options) {
  const request = normalizeSelectionRequest(requestInput);
  const evaluations = buildEligibilityTrace(candidates, request, options);
  const eligible = evaluations.filter((candidate) => candidate.eligible).sort(compareEligible);
  const selected = eligible[0] ?? null;

  return Object.freeze({
    status: selected ? "selected" : "no-eligible-route",
    dryRun: true,
    policy: "lowest-synthetic-estimated-rate-then-lexicographic-route-id",
    rateDisclaimer: "Synthetic/list-price estimates only; not actual cost or savings.",
    request,
    selected,
    candidates: evaluations,
  });
}

export function formatDryRunTrace(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.candidates)) {
    throw new TypeError("formatDryRunTrace requires a selection result with candidates");
  }

  const verdict =
    result.status === "selected" && result.selected
      ? `verdict: selected ${result.selected.routeId}`
      : "verdict: no-eligible-route";

  const lines = ["dry-run eligibility trace"];
  for (const candidate of result.candidates) {
    const candidateVerdict = candidate.eligible ? "eligible" : "excluded";
    lines.push(`${candidate.routeId}: ${candidateVerdict}`);
    for (const entry of candidate.checks ?? []) {
      const suffix = entry.reason ? ` (${entry.reason})` : "";
      lines.push(`  [${entry.status}] ${entry.check}${suffix}`);
    }
  }
  lines.push(verdict);
  return lines.join("\n");
}
