export { CatalogValidationError, normalizeCatalog } from "./catalog.js";
export {
  SupportConfigurationError,
  SupportState,
  applySupportConfiguration,
} from "./support.js";
export {
  CheckStatus,
  EligibilityCheck,
  EligibilityRequestError,
  buildEligibilityTrace,
  evaluateEligibility,
  normalizeSelectionRequest,
} from "./eligibility.js";
export { formatDryRunTrace, selectRoute } from "./selection.js";
export { FakeTransport } from "./transport.js";
