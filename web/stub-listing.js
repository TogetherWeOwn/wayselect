// Stub listing data for the preview-only listing-detail page (TOG-4882).
//
// Shape mirrors catalog-entry v1 field names (providerId, modelId, entry with
// capabilities/modalities/cost) so the slice can later bind to real catalog
// data without renaming. Read-only: no backend writes.
//
// Buyer trust signals (TOG-8061, spec docs/wayselect-buyer-trust-signals.md
// §3): rated stubs carry a frozen optional `rating` object
// `{average: number, sales: integer}` — synthetic aggregate sales history for
// preview display only. `unknown-tools` carries no rating and renders the
// unrated copy. Renderers validate fail-closed (bad data → unrated copy,
// page still 200); this module stores the pinned stub values only.

export const STUB_LISTINGS = Object.freeze([
  Object.freeze({
    schemaVersion: "v1",
    providerId: "northstar",
    providerName: "Northstar Synthetic Provider",
    modelId: "alpha-chat",
    rating: Object.freeze({ average: 4.6, sales: 128 }),
    entry: Object.freeze({
      id: "alpha-chat",
      name: "Alpha Chat",
      attachment: false,
      reasoning: false,
      tool_call: true,
      structured_output: true,
      modalities: Object.freeze({
        input: Object.freeze(["text"]),
        output: Object.freeze(["text"]),
      }),
      cost: Object.freeze({ input: 1, output: 2 }),
    }),
    provenance: Object.freeze({
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    }),
  }),
  Object.freeze({
    schemaVersion: "v1",
    providerId: "northstar",
    providerName: "Northstar Synthetic Provider",
    modelId: "image-lite",
    rating: Object.freeze({ average: 3.9, sales: 17 }),
    entry: Object.freeze({
      id: "image-lite",
      name: "Image Lite",
      attachment: true,
      reasoning: false,
      tool_call: false,
      structured_output: false,
      modalities: Object.freeze({
        input: Object.freeze(["image"]),
        output: Object.freeze(["text"]),
      }),
      cost: Object.freeze({ input: 1, output: 1 }),
    }),
    provenance: Object.freeze({
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    }),
  }),
  // Intentionally missing capability fields (attachment, reasoning, tool_call,
  // structured_output): mirrors the `unknown-tools` fixture model so the
  // catalog surface renders the fail-closed unknown state (TOG-5221).
  // Also intentionally missing `rating`: the unrated stub for TOG-8061.
  Object.freeze({
    schemaVersion: "v1",
    providerId: "northstar",
    providerName: "Northstar Synthetic Provider",
    modelId: "unknown-tools",
    entry: Object.freeze({
      id: "unknown-tools",
      name: "Unknown Tools",
      modalities: Object.freeze({
        input: Object.freeze(["text"]),
        output: Object.freeze(["text"]),
      }),
      cost: Object.freeze({ input: 0.25, output: 0.5 }),
    }),
    provenance: Object.freeze({
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    }),
  }),
]);

export function getStubListing(providerId, modelId) {
  return (
    STUB_LISTINGS.find(
      (listing) => listing.providerId === providerId && listing.modelId === modelId,
    ) ?? null
  );
}
