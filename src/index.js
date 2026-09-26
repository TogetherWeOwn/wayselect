export { CatalogValidationError, normalizeCatalog } from "./catalog.js";
export {
  SupportConfigurationError,
  SupportState,
  applySupportConfiguration,
} from "./support.js";
export {
  EligibilityRequestError,
  evaluateEligibility,
  normalizeSelectionRequest,
} from "./eligibility.js";
export { selectRoute } from "./selection.js";
export { FakeTransport } from "./transport.js";
export {
  CatalogFreshnessError,
  CatalogStaleError,
  checkCatalogFreshness,
  requireFreshCatalog,
} from "./freshness.js";
export {
  DEFAULT_STAGING_SOURCE_PREFIX,
  KNOWN_CAPABILITY_NAMES,
  SnapshotError,
  buildSnapshot,
  computeContentHash,
  findEntryGaps,
  snapshotIsClean,
} from "./snapshot.js";
export {
  SnapshotDiffError,
  compareEntries,
  diffSnapshots,
  formatDiffReport,
} from "./catalogDiff.js";
