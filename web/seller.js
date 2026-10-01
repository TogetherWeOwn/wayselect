// Seller listing-creation confirm + receipt surfaces for the Wayselect
// seller-onboarding slice (TOG-4969; spec: TOG-4958 §3 steps 5–6).
//
// Pure renderers + confirm-model builder over existing boundaries:
// `validateSellerSubmission` (src/sellerSubmission.js) for intake and
// `candidateFromStubListing` / `evaluateListingEligibility` /
// `describeEligibility` (web/eligibility.js) for the eligibility verdict.
// No backend writes anywhere: confirm records intent in the server's
// in-memory map only (restart clears); no live publish, no credentials.
//
// Contract:
//   - `submissionToStubListing(normalized)` adapts a validated submission to
//     the stub-listing shape so the preview eligibility pipeline evaluates
//     it unchanged (unknown routes fall back to `catalogued` support with no
//     evidence — fail closed, never granted).
//   - `confirmModel(normalized)` freezes the restated confirm facts:
//     routeId, title, price as-quoted, normalized capabilities, derived
//     operations, supportState + evidence age, eligibility verdict with the
//     exact evaluator reason codes, and provenance.
//   - `renderSellerConfirm(model)` is the confirm screen HTML; every dynamic
//     value is HTML-escaped and every reason code renders verbatim in
//     `<code>` (no explainer page — same pinned decision as the buyer
//     detail surface).
//   - `confirmModelJson(model)` is the JSON twin of the same facts for the
//     intake POST response.
//   - `renderSellerReceipt(model, timestamp)` is the listing-created receipt:
//     what was created, price as-quoted, timestamp, provenance, dry-run
//     disclaimer. No payment or payout fields anywhere.

import escapeHtmlLib from "escape-html";
import {
  candidateFromStubListing,
  describeEligibility,
  PREVIEW_ELIGIBILITY_OPTIONS,
  PREVIEW_ELIGIBILITY_REQUEST,
} from "./eligibility.js";
import { evaluateEligibility } from "../src/eligibility.js";

function escapeHtml(value) {
  return escapeHtmlLib(String(value));
}

// TOG-6049: nonce attribute for the inline <style> tag, mirroring
// web/listing-detail.js. Omitted nonce → legacy bare tag.
function nonceAttr(cspNonce) {
  return cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : "";
}

function pageNonce(options) {
  return typeof options?.cspNonce === "string" ? options.cspNonce : undefined;
}

function layout({ title, body, cspNonce }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Wayselect</title>
<style${nonceAttr(cspNonce)}>
:root { color-scheme: light dark; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; line-height: 1.5; }
main { max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
.preview-banner { border: 1px dashed currentColor; border-radius: 0.5rem; padding: 0.5rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #888; padding: 0.5rem 0.75rem; text-align: left; }
.badge { display: inline-block; border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.85rem; }
.badge-granted { background: #d3f9d8; color: #1a4d1f; }
.badge-blocked { background: #ffe3e3; color: #7a1f1f; }
.badge-unknown { background: #fff3bf; color: #5c4a00; }
.eligibility { margin-top: 1.5rem; padding: 1rem; border: 1px solid #888; border-radius: 0.5rem; }
.eligibility ul { margin-bottom: 0; }
.confirm { margin-top: 1.5rem; padding: 1rem; border: 1px solid #888; border-radius: 0.5rem; }
.confirm button { font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer; }
.back { display: inline-block; margin-top: 2rem; }
.site-header { max-width: 44rem; margin: 0 auto; padding: 1rem 1rem 0; }
.site-header nav { display: flex; align-items: baseline; gap: 0.75rem; }
.site-title { font-weight: 700; }
.site-tag { font-size: 0.8rem; border: 1px solid currentColor; border-radius: 999px; padding: 0 0.6rem; }
.site-footer { max-width: 44rem; margin: 0 auto; padding: 0 1rem 2rem; font-size: 0.85rem; opacity: 0.85; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 0.75rem; top: -4rem; z-index: 10; background: #fff; color: #000; padding: 0.5rem 1rem; border-radius: 0.375rem; transition: top 0.15s ease-in-out; }
.skip-link:focus-visible { top: 0.75rem; }
main:focus { outline: none; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; border-radius: 0.25rem; }
@media (forced-colors: active) { a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid Highlight; } }
@media (forced-colors: active) { .badge { border: 1px solid CanvasText; } }
@media (prefers-reduced-motion: reduce) { .skip-link { transition: none; } }
</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to main content</a>
<header class="site-header"><nav aria-label="Primary"><span class="site-title">Wayselect</span> <span class="site-tag">Preview</span></nav></header>
<main id="main-content" tabindex="-1">
${body}
</main>
<footer class="site-footer"><p>Preview build: stub data only. No listing is published.</p></footer>
</body>
</html>
`;
}

// Adapt a validated seller submission to the stub-listing shape so the
// shared preview eligibility pipeline evaluates it unchanged. providerName
// is the provider id verbatim (no invented display name); cost rides along
// so rates render as-published.
export function submissionToStubListing(normalized) {
  const entry = normalized.entry ?? {};
  const stubEntry = {
    id: entry.id,
    name: entry.name,
    attachment: entry.attachment,
    reasoning: entry.reasoning,
    tool_call: entry.tool_call,
    structured_output: entry.structured_output,
    modalities: {
      input: [...(entry.modalities?.input ?? [])],
      output: [...(entry.modalities?.output ?? [])],
    },
  };
  if (entry.cost !== null && entry.cost !== undefined) {
    stubEntry.cost = { input: entry.cost.input, output: entry.cost.output };
  }
  return {
    schemaVersion: "v1",
    providerId: normalized.providerId,
    providerName: normalized.providerId,
    modelId: normalized.modelId,
    entry: stubEntry,
    provenance: { ...normalized.provenance },
  };
}

// Freeze the restated confirm facts for a validated submission. New listings
// enter as `catalogued` only (spec SD7): the shared fallback support context
// supplies exactly that, with no operations and no evidence, so the verdict
// fails closed with `support-state:catalogued` + `missing-evidence` until a
// support slice says otherwise.
export function confirmModel(normalized) {
  const listing = submissionToStubListing(normalized);
  const candidate = candidateFromStubListing(listing);
  const [evaluation] = evaluateEligibility(
    [candidate],
    PREVIEW_ELIGIBILITY_REQUEST,
    PREVIEW_ELIGIBILITY_OPTIONS,
  );
  const described = describeEligibility(evaluation);
  const cost = normalized.entry?.cost ?? null;
  return Object.freeze({
    routeId: normalized.routeId,
    providerId: normalized.providerId,
    modelId: normalized.modelId,
    title: normalized.entry?.name ?? normalized.modelId,
    entryId: normalized.entry?.id ?? normalized.modelId,
    price: cost === null ? null : Object.freeze({ input: cost.input, output: cost.output }),
    priceLabel:
      cost === null
        ? "Price unpublished"
        : `in=${cost.input} out=${cost.output}`,
    capabilities: Object.freeze({ ...candidate.capabilities }),
    operations: Object.freeze([...candidate.catalogOperations]),
    supportState: candidate.supportState,
    configuredOperations: Object.freeze([...candidate.configuredOperations]),
    evidenceAge: "no evidence recorded (missing-evidence)",
    eligible: evaluation.eligible,
    reasons: Object.freeze([...evaluation.reasons]),
    verdict: described.label,
    verdictHeadline: described.headline,
    provenance: Object.freeze({ ...normalized.provenance }),
  });
}

// JSON twin of the confirm facts for the intake POST response. No payment,
// payout, charge, or location fields anywhere in the body.
export function confirmModelJson(model) {
  return {
    routeId: model.routeId,
    providerId: model.providerId,
    modelId: model.modelId,
    title: model.title,
    entryId: model.entryId,
    price: model.price,
    priceLabel: model.priceLabel,
    capabilities: { ...model.capabilities },
    operations: [...model.operations],
    supportState: model.supportState,
    configuredOperations: [...model.configuredOperations],
    evidenceAge: model.evidenceAge,
    eligible: model.eligible,
    reasons: [...model.reasons],
    verdict: model.verdict,
    provenance: { ...model.provenance },
  };
}

function capabilityCell(value) {
  if (typeof value !== "boolean") {
    return '<span class="badge badge-unknown">Unknown</span>';
  }
  return value ? "Yes" : "No";
}

function eligibilityBadge(model) {
  const badgeClass =
    model.verdict === "Granted"
      ? "badge-granted"
      : model.verdict === "Blocked"
        ? "badge-blocked"
        : "badge-unknown";
  return `<span class="badge ${badgeClass}" aria-label="eligibility: ${escapeHtml(model.verdict)}">${escapeHtml(model.verdict)}</span>`;
}

function eligibilitySection(model) {
  const reasons =
    model.reasons.length > 0
      ? `<ul>${model.reasons.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("")}</ul>`
      : "";
  return `<section class="eligibility" aria-label="Eligibility">
<h2>Eligibility verdict</h2>
<p>${eligibilityBadge(model)} ${escapeHtml(model.verdictHeadline)}</p>
${reasons}</section>`;
}

function capabilityRows(model) {
  const caps = model.capabilities;
  const rows = [
    ["Attachments", caps.attachment],
    ["Reasoning", caps.reasoning],
    ["Tool calls", caps.toolUse],
    ["Structured output", caps.structuredOutput],
    ["Image input", caps.imageInput],
    ["Text input", caps.textInput],
    ["Text output", caps.textOutput],
  ];
  return rows
    .map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${capabilityCell(value)}</td></tr>`)
    .join("\n");
}

function confirmBody(model) {
  const confirmPath = `/sellers/submissions/${encodeURIComponent(model.providerId)}/${encodeURIComponent(model.modelId)}/confirm`;
  return `<div class="preview-banner" role="note">Preview build: stub data only. Confirming records intent — no listing is published.</div>
<h1>Confirm listing: ${escapeHtml(model.title)}</h1>
<p>Route <code>${escapeHtml(model.routeId)}</code> · entry <code>${escapeHtml(model.entryId)}</code>.</p>
<h2>Price as quoted</h2>
<p>${escapeHtml(model.priceLabel)}</p>
<h2>Normalized capabilities</h2>
<table>
<tbody>
${capabilityRows(model)}
</tbody>
</table>
<h2>Support &amp; evidence</h2>
<table>
<tbody>
<tr><th scope="row">Support state</th><td><code>${escapeHtml(model.supportState)}</code></td></tr>
<tr><th scope="row">Derived operations</th><td>${model.operations.length > 0 ? escapeHtml(model.operations.join(", ")) : "none"}</td></tr>
<tr><th scope="row">Configured operations</th><td>${model.configuredOperations.length > 0 ? escapeHtml(model.configuredOperations.join(", ")) : "none"}</td></tr>
<tr><th scope="row">Evidence age</th><td>${escapeHtml(model.evidenceAge)}</td></tr>
</tbody>
</table>
${eligibilitySection(model)}
<h2>Provenance</h2>
<p>Source <code>${escapeHtml(model.provenance.source)}</code> · fetched <code>${escapeHtml(model.provenance.fetchedAt)}</code>.</p>
<div class="confirm">
<form method="post" action="${escapeHtml(confirmPath)}">
<button type="submit">Confirm listing creation (records intent only)</button>
</form>
<p>No live publish is made in this slice; confirm records intent only.</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;
}

export function renderSellerConfirm(model, options) {
  return layout({
    title: `Confirm ${model.routeId}`,
    body: confirmBody(model),
    cspNonce: pageNonce(options),
  });
}

export function renderSellerReceipt(model, timestamp, options) {
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No listing was published.</div>
<h1>Listing intent recorded: ${escapeHtml(model.title)}</h1>
<p>Route <code>${escapeHtml(model.routeId)}</code> · entry <code>${escapeHtml(model.entryId)}</code>.</p>
<h2>What was recorded</h2>
<table>
<tbody>
<tr><th scope="row">Price as quoted</th><td>${escapeHtml(model.priceLabel)}</td></tr>
<tr><th scope="row">Support state</th><td><code>${escapeHtml(model.supportState)}</code></td></tr>
<tr><th scope="row">Eligibility verdict</th><td>${eligibilityBadge(model)}${model.reasons.length > 0 ? ` <code>${escapeHtml(model.reasons.join(", "))}</code>` : ""}</td></tr>
<tr><th scope="row">Recorded at</th><td><code>${escapeHtml(timestamp)}</code></td></tr>
<tr><th scope="row">Provenance</th><td>Source <code>${escapeHtml(model.provenance.source)}</code> · fetched <code>${escapeHtml(model.provenance.fetchedAt)}</code></td></tr>
</tbody>
</table>
<p><small>Dry-run only: this receipt records intent. No listing was published, no charge was made, and no credentials were collected.</small></p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: `Listing intent ${model.routeId}`, body, cspNonce: pageNonce(options) });
}

// No pending intent for this route: the seller never staged a submission
// (or the server restarted and cleared the in-memory map). Fail closed with
// a named page, never a guessed confirm screen.
export function renderSellerIntentMissing(providerId, modelId, options) {
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No listing is published.</div>
<h1>No pending seller intent</h1>
<p>No staged submission matches <code>${escapeHtml(providerId)}/${escapeHtml(modelId)}</code>. Stage one with <code>POST /sellers/submissions</code> first.</p>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "No pending intent", body, cspNonce: pageNonce(options) });
}

// Fail-closed validation display: the rejection names the offending key +
// provenance source before anything renders. Shared by the HTML error page.
export function renderSellerSubmissionError({ code, key, source, message }, options) {
  const body = `<div class="preview-banner" role="note">Preview build: stub data only. No listing is published.</div>
<div role="alert">
<h1>Submission rejected</h1>
<p>The submission was rejected before anything rendered.</p>
<table>
<tbody>
<tr><th scope="row">Reason code</th><td><code>${escapeHtml(code ?? "invalid-submission")}</code></td></tr>
<tr><th scope="row">Offending key</th><td><code>${escapeHtml(key ?? "submission")}</code></td></tr>
<tr><th scope="row">Provenance source</th><td><code>${escapeHtml(source ?? "provenance missing")}</code></td></tr>
</tbody>
</table>
<p>${escapeHtml(message ?? "Invalid seller submission.")}</p>
</div>
<a class="back" href="/listings">Back to listings</a>`;
  return layout({ title: "Submission rejected", body, cspNonce: pageNonce(options) });
}
