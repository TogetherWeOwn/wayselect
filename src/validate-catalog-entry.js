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
  "catalog-entry",
  "v1.json",
);

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateFn = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));

function provenanceOf(entry) {
  const p = entry && typeof entry === "object" ? entry.provenance : undefined;
  const source =
    p && typeof p.source === "string" && p.source ? p.source : "unknown-source";
  const fetchedAt =
    p && typeof p.fetchedAt === "string" && p.fetchedAt
      ? p.fetchedAt
      : "unknown-fetchedAt";
  return `source=${source} fetchedAt=${fetchedAt}`;
}

function formatErrors(errors) {
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message} (${e.keyword})`)
    .join("; ");
}

/**
 * Validate a single catalog entry, fail-closed.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 * The rejection error always carries provenance so bad entries are traceable.
 */
export function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      ok: false,
      error: `Catalog entry rejected [${provenanceOf(entry)}]: entry must be an object`,
    };
  }
  if (entry.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `Catalog entry rejected [${provenanceOf(entry)}]: ` +
        `unsupported schemaVersion ${JSON.stringify(entry.schemaVersion)} (expected ${JSON.stringify(SCHEMA_VERSION)}); ` +
        `stale or unauthorized entry`,
    };
  }
  const valid = validateFn(entry);
  if (!valid) {
    return {
      ok: false,
      error: `Catalog entry rejected [${provenanceOf(entry)}]: ${formatErrors(validateFn.errors ?? [])}`,
    };
  }
  return { ok: true };
}

export { SCHEMA_VERSION };
