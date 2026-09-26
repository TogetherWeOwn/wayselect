function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Canonical JSON: objects with recursively sorted keys, arrays in order,
// no whitespace. Deterministic across runs and platforms for JSON values.
// The fixture-only provenance hash is computed over this form so QA can
// re-run refresh and compare against the recorded snapshotHash byte for byte.
export function stableStringify(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("catalog body contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("catalog body contains a non-JSON value");
}
