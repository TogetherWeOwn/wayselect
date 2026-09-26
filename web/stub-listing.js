// Stub listing data for the preview-only search/filter slice (TOG-4916).
//
// Shape mirrors catalog-entry v1 field names (providerId, modelId, entry with
// capabilities/modalities/cost, optional status) so the slice can later bind
// to real catalog data without renaming. Fixtures intentionally span several
// input-modality categories (text/image/audio) and all status values
// (stable = absent status, beta, deprecated) so every filter combination has
// coverage. Read-only: no backend writes.

function freezeListing(listing) {
  return Object.freeze({
    ...listing,
    entry: Object.freeze({
      ...listing.entry,
      modalities: Object.freeze({
        input: Object.freeze([...listing.entry.modalities.input]),
        output: Object.freeze([...listing.entry.modalities.output]),
      }),
      cost: Object.freeze({ ...listing.entry.cost }),
    }),
    provenance: Object.freeze({ ...listing.provenance }),
  });
}

const RAW_LISTINGS = [
  {
    schemaVersion: "v1",
    providerId: "northstar",
    providerName: "Northstar Synthetic Provider",
    modelId: "alpha-chat",
    entry: {
      id: "alpha-chat",
      name: "Alpha Chat",
      description: "General-purpose synthetic chat model",
      attachment: false,
      reasoning: false,
      tool_call: true,
      structured_output: true,
      release_date: "2026-01-15",
      last_updated: "2026-09-01",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: false,
      limit: { context: 131072, output: 16384 },
      cost: { input: 1, output: 2 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    schemaVersion: "v1",
    providerId: "northstar",
    providerName: "Northstar Synthetic Provider",
    modelId: "image-lite",
    entry: {
      id: "image-lite",
      name: "Image Lite",
      description: "Lightweight synthetic image-understanding model",
      attachment: true,
      reasoning: false,
      tool_call: false,
      structured_output: false,
      release_date: "2026-03-02",
      last_updated: "2026-09-01",
      modalities: { input: ["image"], output: ["text"] },
      open_weights: false,
      limit: { context: 32768, output: 4096 },
      cost: { input: 1, output: 1 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    schemaVersion: "v1",
    providerId: "orbit",
    providerName: "Orbit Synthetic Provider",
    modelId: "orbit-chat",
    entry: {
      id: "orbit-chat",
      name: "Orbit Chat",
      description: "Reasoning-capable synthetic chat model (beta)",
      attachment: false,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      status: "beta",
      release_date: "2026-08-10",
      last_updated: "2026-09-20",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: false,
      limit: { context: 65536, output: 8192 },
      cost: { input: 1, output: 2 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    schemaVersion: "v1",
    providerId: "orbit",
    providerName: "Orbit Synthetic Provider",
    modelId: "retired-chat",
    entry: {
      id: "retired-chat",
      name: "Retired Chat",
      description: "Superseded synthetic chat model (deprecated)",
      attachment: false,
      reasoning: false,
      tool_call: true,
      structured_output: false,
      status: "deprecated",
      release_date: "2025-06-01",
      last_updated: "2026-02-01",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: false,
      limit: { context: 32768, output: 4096 },
      cost: { input: 0.1, output: 0.1 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    schemaVersion: "v1",
    providerId: "lumen",
    providerName: "Lumen Synthetic Provider",
    modelId: "audio-scribe",
    entry: {
      id: "audio-scribe",
      name: "Audio Scribe",
      description: "Synthetic speech-to-text transcription model",
      attachment: true,
      reasoning: false,
      tool_call: false,
      structured_output: true,
      release_date: "2026-05-18",
      last_updated: "2026-09-10",
      modalities: { input: ["audio"], output: ["text"] },
      open_weights: true,
      limit: { context: 16384, output: 8192 },
      cost: { input: 0.5, output: 0.5 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
  {
    schemaVersion: "v1",
    providerId: "legacy",
    providerName: "Legacy Synthetic Provider",
    modelId: "old-chat",
    entry: {
      id: "old-chat",
      name: "Old Chat",
      description: "Original synthetic chat model",
      attachment: false,
      reasoning: false,
      tool_call: true,
      structured_output: false,
      release_date: "2025-01-01",
      last_updated: "2025-12-01",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: true,
      limit: { context: 8192, output: 2048 },
      cost: { input: 0.5, output: 1.5 },
    },
    provenance: {
      source: "synthetic://wayselect/fixture-v1",
      fetchedAt: "2026-09-24T10:00:00.000Z",
    },
  },
];

export const STUB_LISTINGS = Object.freeze(RAW_LISTINGS.map(freezeListing));

export function getStubListing(providerId, modelId) {
  return (
    STUB_LISTINGS.find(
      (listing) => listing.providerId === providerId && listing.modelId === modelId,
    ) ?? null
  );
}
