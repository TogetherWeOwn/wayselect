import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const SCHEMA_VERSION = "v1";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schema",
  "cli-json",
  "v1.json",
);

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateFn = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function formatErrors(errors) {
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message} (${e.keyword})`)
    .join("; ");
}

function crossFieldError(payload) {
  if (payload.status === "selected" && payload.selectedRouteId === null) {
    return "status is selected but selectedRouteId is null";
  }
  if (payload.status === "no-eligible-route" && payload.selectedRouteId !== null) {
    return "status is no-eligible-route but selectedRouteId is not null";
  }
  const candidates = payload.rankedCandidates;
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index].rank !== index + 1) {
      return `rankedCandidates[${index}].rank is ${candidates[index].rank}, expected ${index + 1}`;
    }
  }
  for (const candidate of candidates) {
    if (candidate.eligible && candidate.reasons.length > 0) {
      return `${candidate.routeId} is eligible but carries reasons`;
    }
    if (!candidate.eligible && candidate.reasons.length === 0) {
      return `${candidate.routeId} is excluded but carries no reasons`;
    }
  }
  if (payload.status === "selected") {
    const [first] = candidates;
    if (!first.eligible || first.routeId !== payload.selectedRouteId) {
      return "status is selected but the top-ranked candidate is not the selected route";
    }
  }
  return null;
}

/**
 * Validate a `select --json` / `explain --json` payload, fail-closed.
 *
 * Structural shape comes from schema/cli-json/v1.json (additionalProperties
 * is false at every level, so undeclared fields are rejected); the
 * status/selectedRouteId/rank/eligibility invariants the structural schema
 * cannot express are checked explicitly.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateCliJson(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      error: "CLI --json payload rejected [v1]: payload must be an object",
    };
  }
  const valid = validateFn(payload);
  if (!valid) {
    return {
      ok: false,
      error: `CLI --json payload rejected [v1]: ${formatErrors(validateFn.errors ?? [])}`,
    };
  }
  const invariant = crossFieldError(payload);
  if (invariant !== null) {
    return {
      ok: false,
      error: `CLI --json payload rejected [v1]: ${invariant}`,
    };
  }
  return { ok: true };
}

export { SCHEMA_VERSION };
