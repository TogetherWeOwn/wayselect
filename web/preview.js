// Preview-flag gate for the Wayselect web slice (TOG-4882).
//
// Convention: the listing-detail page renders only when the WAYSELECT_PREVIEW
// flag is enabled. The flag is read-only runtime config — no backend writes.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isPreviewEnabled(env = process.env) {
  const raw = env?.WAYSELECT_PREVIEW;
  if (raw === undefined || raw === null) {
    return false;
  }
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

export function previewFlagName() {
  return "WAYSELECT_PREVIEW";
}
