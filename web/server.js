// Minimal preview web server for the Wayselect listing-detail slice (TOG-4882)
// with the shell-first loading state (TOG-5499).
//
// Zero dependencies: Node built-in http only. Routes:
//   GET /healthz                            — liveness probe (TOG-5726):
//                                            `{status:"ok",version}` JSON,
//                                            ungated by WAYSELECT_PREVIEW
//                                            and exempt from rate limiting
//   GET /favicon.ico                         — 204 No Content (TOG-6369):
//                                            ungated by WAYSELECT_PREVIEW;
//                                            pins the browser-requested icon
//                                            path so page loads stop emitting
//                                            404 log noise
//   GET /listings                          — stub listing index (flag-gated;
//                                            flag-on honors `Accept:
//                                            application/json` with the paged
//                                            result / invalid-filter error;
//                                            flag-off stays HTML-only)
//   GET /listings/:provider/:model         — listing-detail shell (flag-gated;
//                                            `Accept: application/json` returns
//                                            the `{ html }` content fragment)
//   POST /listings/:provider/:model/purchase — stub CTA target: 404 for
//                                            unknown listings, 403 for known
//                                            listings (no backend writes)
//   POST /sellers/submissions                — seller intake (TOG-4969):
//                                            validates the JSON body with
//                                            validateSellerSubmission and
//                                            records a pending intent
//                                            in-memory (restart clears)
//   GET /sellers/submissions/:provider/:model/confirm
//                                          — confirm screen (TOG-4969):
//                                            restates route, price, support,
//                                            evidence age + verdict
//   POST /sellers/submissions/:provider/:model/confirm
//                                          — records intent, returns the
//                                            listing-created receipt
//                                            (no live publish, ever)
// Everything else 404. When WAYSELECT_PREVIEW is off, gated routes return 404.
//
// Security headers (TOG-5731, nonce CSP TOG-6049):
//   - Every response carries `X-Content-Type-Options: nosniff` (HTML and
//     JSON alike, including the 429 rate-limit refusal below).
//   - HTML responses additionally deny framing (`X-Frame-Options: DENY`
//     plus `frame-ancestors 'none'`) and carry a per-response nonce CSP.
//     Feasibility verdict (TOG-6049): nonces work — every page carries
//     exactly one inline `<style>` block and the detail shell exactly one
//     inline `<script>` (same-origin fetch of the JSON fragment); there
//     are no event-handler attributes, no `style=` attributes, and no
//     dynamic script/style injection, so `style-src`/`script-src`
//     allowlist exactly the request nonce and `'unsafe-inline'` is gone.
//     Effort was trivial: one `randomBytes` nonce per HTML response,
//     stamped on the inline tags and allowlisted in the header.
//
// 404 content-type contract (TOG-5714, flag-off JSON TOG-6375, index JSON TOG-7661):
//   - Browser routes (index, detail incl. listing misses, flag-off pages):
//     HTML by default; JSON only when the client explicitly negotiates
//     `Accept: application/json` (the shell's fragment fetch; index JSON
//     callers likewise). Flag-off JSON is `{error: "preview_disabled"}`
//     so the shell renders its alert panel instead of choking on an HTML
//     page. Flag-on index JSON is the paged result
//     `{listings, total, limit, offset}` (200, incl. empty states) or
//     `{error: "invalid_filter", kind, value, valid, errors}` (400, plus the
//     TOG-6717 request id like every JSON error).
//     The flag-off index stays HTML-only — it has no fragment shape.
//   - API-shaped routes (purchase stub incl. 405s) and unparseable targets:
//     always JSON.
//   - Unknown paths (fallback below): JSON `{error: "not_found"}` by
//     default; HTML only when the client explicitly negotiates
//     `Accept: text/html` without `application/json` (a browser address-bar
//     navigation). `*/*` (fetch/curl defaults) gets JSON.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { isPreviewEnabled } from "./preview.js";
import { createRateLimiter, resolveClientIp } from "./rate-limit.js";
import {
  listingDetailFragment,
  renderInvalidFilter,
  renderListingDetail,
  renderListingDetailError,
  renderListingDetailShell,
  renderListingIndex,
  renderNotFound,
  renderPreviewDisabled,
  renderRouteNotFound,
} from "./listing-detail.js";
import {
  applyListingsFilters,
  paginateListings,
  parseListingsQuery,
  sortListings,
} from "./filter.js";
import { STUB_LISTINGS, getStubListing } from "./stub-listing.js";
import { readJsonBody } from "./jsonBody.js";
import {
  confirmModel,
  confirmModelJson,
  renderSellerConfirm,
  renderSellerIntentMissing,
  renderSellerReceipt,
  renderSellerSubmissionError,
} from "./seller.js";
import { SellerSubmissionError, validateSellerSubmission } from "../src/sellerSubmission.js";

const LISTING_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/?$/;
const PURCHASE_ROUTE = /^\/listings\/([^/]+)\/([^/]+)\/purchase\/?$/;
const SELLER_INTAKE_ROUTE = /^\/sellers\/submissions\/?$/;
const SELLER_CONFIRM_ROUTE = /^\/sellers\/submissions\/([^/]+)\/([^/]+)\/confirm\/?$/;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// HTML-only hardening (TOG-5731, nonces TOG-6049): deny framing both the
// legacy (`X-Frame-Options`) and the standard (`frame-ancestors`) way, and
// lock the page to same-origin resources with a per-response CSP. Every
// page carries one inline `<style>` block and the detail shell carries one
// inline `<script>` that same-origin fetches its JSON fragment — both
// carry the request nonce (`newCspNonce`), so `style-src`/`script-src`
// allowlist exactly that nonce and there is no `'unsafe-inline'` anywhere.
// `form-action 'self'` covers the filter GET form and the purchase POST
// form. TOG-6368: `X-Robots-Tag: noindex, nofollow` keeps stub preview
// pages out of search indexes — defense in depth alongside the
// `<meta name="robots">` tag in both HTML layouts (web/listing-detail.js,
// web/seller.js), covering crawlers that ignore the meta tag.
const HTML_SECURITY_HEADERS = {
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
};

// TOG-6049: 128-bit nonce per HTML response (base64, CSP grammar-safe).
// Fresh value on every response: a leaked page source cannot authorize
// script/style on any other response.
export function newCspNonce() {
  return randomBytes(16).toString("base64");
}

// Per-request correlation id (TOG-6717): every JSON error carries a
// crypto-random id both as an `x-request-id` response header and as
// `requestId` in the body, so staging triage can match a response to logs.
// 128-bit hex (32 lowercase chars) minted per response — client input is
// never trusted or echoed. Success JSON carries no id (error-only scope).
export const REQUEST_ID_HEADER = "x-request-id";

export function newRequestId() {
  return randomBytes(16).toString("hex");
}

export function htmlCsp(nonce) {
  return (
    "default-src 'self'; frame-ancestors 'none'; " +
    `style-src 'self' 'nonce-${nonce}'; script-src 'self' 'nonce-${nonce}'; ` +
    "img-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'"
  );
}

function sendHtml(res, status, html, nonce) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...SECURITY_HEADERS,
    ...HTML_SECURITY_HEADERS,
    "content-security-policy": htmlCsp(nonce),
  });
  res.end(html);
}

// Shared JSON-error writer (TOG-6717): mints one crypto-random request id
// per error response, stamps it on the `x-request-id` header, and echoes it
// as `requestId` in the body, so staging triage can match a response to
// logs. Every JSON error path funnels through here — `sendJson`'s error
// branch, `sendMethodNotAllowed`, the inline 429 refusal, and the direct
// `sendJson` 405 — so the id is always present and header and body always
// agree. Error JSON is dynamic (per-request 403/404/405/400/413 bodies,
// never cacheable content), so error statuses also carry
// `Cache-Control: no-store` (TOG-6367).
function sendJsonError(res, status, payload, extraHeaders = {}) {
  const requestId = newRequestId();
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    ...extraHeaders,
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(JSON.stringify({ ...payload, requestId }));
}

function sendJson(res, status, payload) {
  if (status >= 400) {
    sendJsonError(res, status, payload);
    return;
  }
  // Success JSON keeps default cache semantics: cacheable GETs (ETag,
  // validators, 304) belong to TOG-6050, which decides per route there.
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(payload));
}

// Wrong-method refusal (TOG-6364): RFC 9110 §15.5.6 requires a 405 response
// to carry an `Allow` header naming the methods the target supports. Every
// known route shape funnels through here so OPTIONS/PUT/DELETE behave the
// same on every route; unknown paths stay 404 (no resource, no `Allow`).
// Always an error, so always `Cache-Control: no-store` (TOG-6367) plus the
// request id (TOG-6717) via the shared writer.
function sendMethodNotAllowed(res, allow) {
  sendJsonError(res, 405, { error: "method_not_allowed" }, { allow });
}

// Bucket requests by route shape for the rate limiter: exact path for the
// index, route templates for detail/purchase, and a fallback for 404s so
// scanners cannot burn the budget of real routes (or vice versa).
function routeBucket(method, pathname) {
  // NOTE: /favicon.ico and /healthz answer before the limiter (see the
  // handler), so they never reach a bucket — do not add entries for them.
  if (method === "GET" && (pathname === "/listings" || pathname === "/listings/")) {
    return "GET /listings";
  }
  if (PURCHASE_ROUTE.test(pathname)) {
    return `${method} /listings/:provider/:model/purchase`;
  }
  if (SELLER_CONFIRM_ROUTE.test(pathname)) {
    return `${method} /sellers/submissions/:provider/:model/confirm`;
  }
  if (SELLER_INTAKE_ROUTE.test(pathname)) {
    return `${method} /sellers/submissions`;
  }
  if (LISTING_ROUTE.test(pathname)) {
    return `${method} /listings/:provider/:model`;
  }
  return `${method} other`;
}

// Server version reported by GET /healthz (TOG-5726). Read once at module
// load from the package manifest; a missing/unparseable manifest degrades
// to "unknown" rather than breaking the server.
function loadServerVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    return typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version
      : "unknown";
  } catch {
    return "unknown";
  }
}

export const SERVER_VERSION = loadServerVersion();

// Slow-header/slow-body caps (TOG-6713): Node's defaults (headersTimeout 60s,
// requestTimeout 300s) let a slowloris-style drip hold a socket for minutes —
// the only timers that existed here were the fragment-delay test knob, which
// delays a response that was already fully received and protects nothing.
// headersTimeout caps header receipt; requestTimeout caps headers + body.
// headersTimeout stays below requestTimeout, as the Node docs recommend.
// requestTimeout only fires on stalled receipt (no data moving) — it never
// kills a slow-but-progressing handler, so the
// WAYSELECT_DETAIL_FRAGMENT_DELAY_MS dev knob (post-receipt delay) is
// unaffected, and neither timer touches idle keep-alive sockets.
export const HTTP_TIMEOUT_DEFAULTS = Object.freeze({
  headersTimeout: 10_000,
  requestTimeout: 120_000,
});

// Override ceiling: anything above Node's own 5-minute requestTimeout default
// re-opens the slowloris window these defaults close.
const HTTP_TIMEOUT_MAX_MS = 300_000;

export function configureHttpTimeouts(server, overrides = {}) {
  const {
    headersTimeout = HTTP_TIMEOUT_DEFAULTS.headersTimeout,
    requestTimeout = HTTP_TIMEOUT_DEFAULTS.requestTimeout,
  } = overrides ?? {};
  for (const [name, value] of [
    ["headersTimeout", headersTimeout],
    ["requestTimeout", requestTimeout],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > HTTP_TIMEOUT_MAX_MS) {
      throw new RangeError(
        `Invalid ${name} ${JSON.stringify(value)}: expected an integer 1-${HTTP_TIMEOUT_MAX_MS} ms`,
      );
    }
  }
  if (headersTimeout > requestTimeout) {
    throw new RangeError(
      `Invalid http timeouts: headersTimeout (${headersTimeout} ms) must not exceed requestTimeout (${requestTimeout} ms)`,
    );
  }
  server.headersTimeout = headersTimeout;
  server.requestTimeout = requestTimeout;
  return { headersTimeout, requestTimeout };
}

// Seller-intent TTL (TOG-6716): a staged intent stays confirmable for 15
// minutes after intake; afterwards it 404s as missing and is dropped from
// the map. One named constant so the value lives in a single place.
export const SELLER_INTENT_TTL_MS = 15 * 60 * 1000;

export function createApp(env = process.env, options = {}) {
  const limiter = options.rateLimiter ?? createRateLimiter(options.rateLimit);
  // Clock for intent expiry (TOG-6716): injectable via `options.now` so
  // tests can pin the expiry boundary; production uses wall-clock time.
  const now = options.now ?? Date.now;
  // Structured request logging (TOG-5739): one JSON line per request —
  // `{method, path, status, latencyMs}` — emitted on `res` finish so delayed
  // paths (the detail-fragment `setTimeout`) report honest end-to-end
  // latency. Injectable sink for tests (default console.log); unparseable
  // targets log the raw target verbatim.
  // eslint-disable-next-line no-console
  const logger = options.logger ?? ((line) => console.log(line));
  // Pending seller intents (TOG-4969) with expiry (TOG-6716):
  // routeId -> { model, storedAt }. In-memory only — restart clears.
  // Confirm records intent; nothing here publishes, charges, or persists.
  // Expired entries 404 as missing on read and are swept on intake, so
  // unread stale intents cannot grow the map.
  const sellerIntents = new Map();
  // Reads the live intent for a route: null when never staged or expired.
  // Expired entries are deleted on read so a stale confirm never revives.
  function getLiveIntent(routeId) {
    const entry = sellerIntents.get(routeId) ?? null;
    if (!entry) {
      return null;
    }
    if (now() - entry.storedAt >= SELLER_INTENT_TTL_MS) {
      sellerIntents.delete(routeId);
      return null;
    }
    return entry.model;
  }
  // Drops every expired entry. Runs on intake so intents nobody ever
  // confirms still leave the map instead of leaking.
  function sweepExpiredIntents() {
    for (const [routeId, entry] of sellerIntents) {
      if (now() - entry.storedAt >= SELLER_INTENT_TTL_MS) {
        sellerIntents.delete(routeId);
      }
    }
  }
  // XFF trust boundary (TOG-6029): unset by default (direct-remote only).
  // Opt-in for a single trusted proxy hop via `trustedProxyIp` option or
  // the `WAYSELECT_TRUSTED_PROXY_IP` env var — exactly one peer IP. Empty
  // string env counts as unset. Documented in rate-limit.js; no prod use.
  const rawTrusted = options.trustedProxyIp ?? env.WAYSELECT_TRUSTED_PROXY_IP ?? null;
  const trustedProxyIp = rawTrusted === null || String(rawTrusted).trim() === "" ? null : String(rawTrusted).trim();
  // Slowloris guard (TOG-6713): cap header/body receipt on every server this
  // factory builds — test and prod share the path, so the pin cannot drift.
  // No `clientError` listener is registered anywhere, so an expired socket
  // gets Node's default 408 + destroy. Tightened per server via
  // `httpTimeouts: { headersTimeout, requestTimeout }` (see
  // configureHttpTimeouts for the bounds).
  const server = createServer(async (req, res) => {
    // Structured logging preamble (TOG-5739): capture start + path now, emit
    // one JSON line on `res` finish so delayed paths report honest latency.
    // Async handler: the seller intake route awaits the strict JSON body gate.
    const startMs = Date.now();
    let logPath;
    try {
      logPath = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      logPath = req.url ?? "/";
    }
    res.on("finish", () => {
      logger(
        JSON.stringify({
          method: req.method,
          path: logPath,
          status: res.statusCode,
          latencyMs: Date.now() - startMs,
        }),
      );
    });
    // TOG-5726: /healthz is the orchestrator liveness probe. It answers
    // before rate limiting (a saturated limiter must not look like a dead
    // server) and regardless of WAYSELECT_PREVIEW (the flag gates content
    // routes, not process health). Pathname match: query strings still hit
    // the probe, but a trailing slash is a different path and falls through
    // to the 404 contract below.
    let probePathname = null;
    try {
      probePathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      probePathname = null;
    }
    if (req.method === "GET" && probePathname === "/healthz") {
      sendJson(res, 200, { status: "ok", version: SERVER_VERSION });
      return;
    }
    if (probePathname === "/healthz") {
      sendMethodNotAllowed(res, "GET");
      return;
    }

    // TOG-6369: the favicon path answers before rate limiting (every page
    // load requests it, so it must never read as a dead route under a
    // saturated limiter) and regardless of WAYSELECT_PREVIEW: 204 No
    // Content by design — there is no icon asset to serve. Non-GET methods
    // are 405 with `Allow: GET` per the TOG-6364 convention.
    if (probePathname === "/favicon.ico") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      res.writeHead(204, { ...SECURITY_HEADERS });
      res.end();
      return;
    }

    // Per-IP/per-route cap (TOG-5563). Bucket by route shape so one hot
    // listing cannot starve — or be starved by — unrelated routes.
    // Unparseable targets count against the fallback bucket so garbage
    // requests cannot bypass the cap. Client identity goes through
    // resolveClientIp so spoofed XFF from an untrusted peer never evades
    // the bucket (TOG-6029).
    const ip = resolveClientIp(
      req.socket?.remoteAddress ?? "unknown",
      req.headers?.["x-forwarded-for"],
      trustedProxyIp,
    );
    let pathname = null;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      pathname = null;
    }
    const bucket = pathname === null ? `${req.method} other` : routeBucket(req.method, pathname);
    const verdict = limiter.check(ip, bucket);
    if (!verdict.allowed) {
      // TOG-5732 audit: the 429 path previously bypassed sendJson and so
      // missed SECURITY_HEADERS — every response carries them now.
      // TOG-6367: the refusal body is dynamic, so `no-store` like every
      // other JSON error. TOG-6717: request id via the shared writer so the
      // refusal is triageable like every other JSON error.
      sendJsonError(
        res,
        429,
        { error: "rate_limited", retryAfterSec: verdict.retryAfterSec },
        { "retry-after": String(verdict.retryAfterSec) },
      );
      return;
    }

    if (pathname === null) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (pathname === "/listings" || pathname === "/listings/") {
      // TOG-6364: the index supports GET only. Non-GET methods are 405
      // (not 404) with `Allow: GET` per RFC 9110 §15.5.6.
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      // TOG-6049: mint one nonce per HTML response; stamp it on the inline
      // tags via the renderer and allowlist exactly it in the CSP header.
      const nonce = newCspNonce();
      const sendPage = (status, html) => sendHtml(res, status, html, nonce);
      const pageOpts = { cspNonce: nonce };
      if (!isPreviewEnabled(env)) {
        // TOG-6375: the flag-off index stays HTML-only even under JSON
        // negotiation — it has no fragment shape, flag-on or flag-off.
        sendPage(404, renderPreviewDisabled(pageOpts));
        return;
      }
      // TOG-7661: the flag-on index negotiates like the detail route —
      // `Accept: application/json` gets the machine-readable result/error
      // payload instead of the HTML page, so `fetch(...).json()` never
      // parses HTML (the TOG-5499 failure mode on the detail side).
      // `Vary: Accept` on every variant so a shared cache keys on it. The
      // 400 error JSON carries the TOG-6717 request id via sendJson's error
      // branch like every other JSON error.
      res.setHeader("vary", "Accept");
      const wantsIndexJson = String(req.headers?.accept ?? "").includes("application/json");
      let params;
      try {
        params = new URL(req.url ?? "/", "http://localhost").searchParams;
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const parsed = parseListingsQuery(params);
      if (!parsed.ok) {
        if (wantsIndexJson) {
          sendJson(res, 400, {
            error: "invalid_filter",
            kind: parsed.kind,
            value: parsed.value,
            valid: parsed.valid,
            errors: parsed.errors,
          });
          return;
        }
        sendPage(400, renderInvalidFilter(parsed, pageOpts));
        return;
      }
      const filtered = applyListingsFilters(STUB_LISTINGS, parsed.filters);
      // TOG-6362: explicit `sort` orders the filtered set before the window
      // is sliced; `default` returns input order, so the legacy stub order
      // is unchanged unless the caller asks otherwise.
      const ordered = sortListings(filtered, parsed.filters.sort);
      // TOG-6028: bound the HTML render with limit/offset (fail-closed above).
      const { page, total, limit, offset } = paginateListings(ordered, parsed.paging);
      if (wantsIndexJson) {
        sendJson(res, 200, { listings: page, total, limit, offset });
        return;
      }
      sendPage(
        200,
        renderListingIndex(page, undefined, parsed.filters, { total, limit, offset }, pageOpts),
      );
      return;
    }

    const purchaseMatch = pathname.match(PURCHASE_ROUTE);
    if (purchaseMatch) {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      // TOG-5710: a nonexistent resource must 404 first; 403 is only
      // correct for a real listing (writes disabled by design).
      const [, rawProviderId, rawModelId] = purchaseMatch;
      let providerId;
      let modelId;
      try {
        providerId = decodeURIComponent(rawProviderId);
        modelId = decodeURIComponent(rawModelId);
      } catch {
        sendJson(res, 404, { error: "listing_not_found" });
        return;
      }
      if (!getStubListing(providerId, modelId)) {
        sendJson(res, 404, { error: "listing_not_found" });
        return;
      }
      // Stub CTA target: never writes, always refuses.
      sendJson(res, 403, {
        error: "preview_only",
        message: "Purchases are disabled in preview. No backend writes.",
      });
      return;
    }

    // Seller submission intake (TOG-4969): strict JSON body gate, then the
    // fail-closed seller validator. 200 + confirm model on success; 400 with
    // the offending key + provenance source on rejection (JSON for API
    // callers, the named rejection page for browsers). Flag-gated; no live
    // publish anywhere on this path.
    if (SELLER_INTAKE_ROUTE.test(pathname)) {
      // TOG-6707: wrong-method refusal goes through the shared helper so
      // the 405 carries `Allow: POST` per RFC 9110 §15.5.6.
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      // TOG-6708 (gap R4-02): this route negotiates HTML vs JSON on
      // `Accept`, so every variant carries `Vary: Accept` — otherwise a
      // shared cache can poison the variant on a later request.
      res.setHeader("vary", "Accept");
      if (!isPreviewEnabled(env)) {
        sendJson(res, 404, { error: "preview_disabled" });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        // R4-06: a body that never completes within the read bound is a
        // timeout (408), not a malformed payload (400) — the client may
        // retry. `body_too_large` stays 413; everything else stays 400.
        const status = body.code === "body_too_large" ? 413 : body.code === "body_timeout" ? 408 : 400;
        sendJson(res, status, {
          error: body.code,
          key: "submission",
          source: null,
          message: `Seller submission rejected: ${body.code}.`,
        });
        return;
      }
      let normalized;
      try {
        normalized = validateSellerSubmission(body.value);
      } catch (error) {
        if (!(error instanceof SellerSubmissionError)) {
          throw error;
        }
        const payload = {
          error: "invalid_submission",
          code: error.code ?? "invalid-submission",
          key: error.key ?? "submission",
          source: error.source ?? null,
          message: error.message,
        };
        if (String(req.headers?.accept ?? "").includes("text/html")) {
          const nonce = newCspNonce();
          sendHtml(res, 400, renderSellerSubmissionError(payload, { cspNonce: nonce }), nonce);
          return;
        }
        sendJson(res, 400, payload);
        return;
      }
      const model = confirmModel(normalized);
      sweepExpiredIntents();
      sellerIntents.set(model.routeId, { model, storedAt: now() });
      const confirmPath = `/sellers/submissions/${encodeURIComponent(model.providerId)}/${encodeURIComponent(model.modelId)}/confirm`;
      if (String(req.headers?.accept ?? "").includes("text/html")) {
        const nonce = newCspNonce();
        sendHtml(res, 200, renderSellerConfirm(model, { cspNonce: nonce }), nonce);
        return;
      }
      sendJson(res, 200, { ...confirmModelJson(model), confirmPath });
      return;
    }

    // Seller confirm + receipt (TOG-4969): GET restates the pending intent,
    // POST records it and returns the listing-created receipt. Both 404 when
    // no intent was staged; neither publishes anything.
    const sellerConfirmMatch = pathname.match(SELLER_CONFIRM_ROUTE);
    if (sellerConfirmMatch) {
      // TOG-6708 (gap R4-02): GET restates the intent as HTML or JSON
      // depending on `Accept` — every variant carries `Vary: Accept`.
      res.setHeader("vary", "Accept");
      if (!isPreviewEnabled(env)) {
        if (req.method === "GET" && !String(req.headers?.accept ?? "").includes("application/json")) {
          const nonce = newCspNonce();
          sendHtml(res, 404, renderPreviewDisabled({ cspNonce: nonce }), nonce);
          return;
        }
        sendJson(res, 404, { error: "preview_disabled" });
        return;
      }
      const [, rawSellerProvider, rawSellerModel] = sellerConfirmMatch;
      let providerId;
      let modelId;
      try {
        providerId = decodeURIComponent(rawSellerProvider);
        modelId = decodeURIComponent(rawSellerModel);
      } catch {
        sendJson(res, 404, { error: "not_found" });
        return;
      }
      const routeId = `${providerId}/${modelId}`;
      const model = getLiveIntent(routeId);
      if (req.method === "GET") {
        if (!model) {
          if (String(req.headers?.accept ?? "").includes("text/html")) {
            const nonce = newCspNonce();
            sendHtml(
              res,
              404,
              renderSellerIntentMissing(providerId, modelId, { cspNonce: nonce }),
              nonce,
            );
            return;
          }
          sendJson(res, 404, { error: "no_pending_intent", routeId });
          return;
        }
        if (String(req.headers?.accept ?? "").includes("text/html")) {
          const nonce = newCspNonce();
          sendHtml(res, 200, renderSellerConfirm(model, { cspNonce: nonce }), nonce);
          return;
        }
        sendJson(res, 200, confirmModelJson(model));
        return;
      }
      if (req.method === "POST") {
        if (!model) {
          sendJson(res, 404, { error: "no_pending_intent", routeId });
          return;
        }
        const recordedAt = new Date().toISOString();
        const receipt = {
          recorded: true,
          intentOnly: true,
          recordedAt,
          ...confirmModelJson(model),
        };
        if (String(req.headers?.accept ?? "").includes("text/html")) {
          const nonce = newCspNonce();
          sendHtml(res, 200, renderSellerReceipt(model, recordedAt, { cspNonce: nonce }), nonce);
          return;
        }
        sendJson(res, 200, receipt);
        return;
      }
      // TOG-5739: wrong-method refusals funnel through the shared 405
      // helper so every known route carries `Allow` (RFC 9110). The confirm
      // route supports GET (restate) and POST (record).
      sendMethodNotAllowed(res, "GET, POST");
      return;
    }

    const listingMatch = pathname.match(LISTING_ROUTE);
    if (listingMatch) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      // TOG-6708 (gap R4-02): shell vs JSON fragment (and the flag-off
      // JSON error shape) select on `Accept` — `Vary: Accept` on all of it.
      res.setHeader("vary", "Accept");
      // TOG-6049: one nonce per HTML response (see index route above).
      // The JSON fragment and its error paths carry no CSP — only the 500
      // HTML fallback (render throw) mints a nonce.
      const nonce = newCspNonce();
      const sendPage = (status, html) => sendHtml(res, status, html, nonce);
      const pageOpts = { cspNonce: nonce };
      if (!isPreviewEnabled(env)) {
        // TOG-6375: the shell's fragment fetch negotiates JSON, so a
        // flag-off fragment request degrades to a JSON error the shell
        // renders as its alert panel — never an HTML page that breaks
        // `res.json()`. Flag check precedes listing lookup, so unknown
        // listings gate identically. The flag-off index stays HTML-only
        // (TOG-6375): it has no fragment shape — only the flag-on index
        // negotiates JSON (TOG-7661).
        if (String(req.headers?.accept ?? "").includes("application/json")) {
          sendJson(res, 404, { error: "preview_disabled" });
          return;
        }
        sendPage(404, renderPreviewDisabled(pageOpts));
        return;
      }
      const [, providerId, modelId] = listingMatch;
      let decodedProviderId;
      let decodedModelId;
      try {
        decodedProviderId = decodeURIComponent(providerId);
        decodedModelId = decodeURIComponent(modelId);
      } catch {
        sendPage(404, renderNotFound(providerId, modelId, pageOpts));
        return;
      }
      const listing = getStubListing(decodedProviderId, decodedModelId);
      if (!listing) {
        // TOG-5499: fragment callers (the shell's inline fetch) negotiate
        // JSON, so misses degrade to an error payload the shell renders as
        // the alert panel — never a JSON parse crash on an HTML page.
        if (String(req.headers?.accept ?? "").includes("application/json")) {
          sendJson(res, 404, { error: "listing_not_found" });
          return;
        }
        sendPage(404, renderNotFound(providerId, modelId, pageOpts));
        return;
      }
      // TOG-5499: the shell's inline fetch negotiates this fragment.
      // Test/dev slow-network knob: delays the fragment only, never the
      // shell first paint. Unset or non-positive means no delay.
      // TOG-6714: the delay must not outlive the client — an aborted
      // stream otherwise leaves a pending timer whose send writes to a
      // dead socket. `req` 'close' fires on client abort (it also fires
      // on normal completion, so the fired-timer path removes its own
      // listener — a completed fragment leaves zero pending timers and
      // zero stray listeners behind). The fired path additionally skips
      // the send when the socket is already gone: the abort can win the
      // race after the delay elapses, and a dropped fragment sends
      // nothing rather than writing to a destroyed socket.
      if (String(req.headers?.accept ?? "").includes("application/json")) {
        const sendFragment = () => {
          try {
            sendJson(res, 200, listingDetailFragment(listing));
          } catch {
            const errNonce = newCspNonce();
            sendHtml(
              res,
              500,
              renderListingDetailError(decodedProviderId, decodedModelId, { cspNonce: errNonce }),
              errNonce,
            );
          }
        };
        const fragmentDelayMs = Number.parseInt(
          String(env.WAYSELECT_DETAIL_FRAGMENT_DELAY_MS ?? "0"),
          10,
        );
        if (Number.isFinite(fragmentDelayMs) && fragmentDelayMs > 0) {
          const onFragmentAbort = () => clearTimeout(fragmentTimer);
          const fragmentTimer = setTimeout(() => {
            req.removeListener("close", onFragmentAbort);
            // The abort may win the race after the delay elapses: writing
            // to a destroyed socket throws, and the throw inside sendJson
            // would escape through the timer (the inner catch's sendHtml
            // throws again). A dropped fragment sends nothing — skip it.
            if (!res.destroyed && !res.writableEnded) {
              sendFragment();
            }
          }, fragmentDelayMs);
          if (req.destroyed || req.closed) {
            // The client was already gone before the timer was armed —
            // 'close' already fired, so the listener below would never run
            // and the timer would leak. Drop it immediately.
            clearTimeout(fragmentTimer);
          } else {
            req.once("close", onFragmentAbort);
          }
        } else {
          sendFragment();
        }
        return;
      }
      try {
        sendPage(200, renderListingDetailShell(listing, undefined, pageOpts));
      } catch {
        sendPage(500, renderListingDetailError(decodedProviderId, decodedModelId, pageOpts));
      }
      return;
    }

    // TOG-5714 fallback (see the 404 content-type contract above):
    // unknown paths are JSON by default; HTML only for explicit browser
    // navigation (`Accept: text/html` without `application/json`). `*/*`
    // (fetch/curl defaults) and missing Accept get JSON.
    const accept = String(req.headers?.accept ?? "");
    // TOG-6708 (gap R4-02): the fallback negotiates JSON vs HTML on
    // `Accept` — a shared cache must key on it.
    res.setHeader("vary", "Accept");
    if (!accept.includes("application/json") && accept.includes("text/html")) {
      // TOG-6049: the browser fallback is an HTML response, so it mints its
      // own nonce like every other HTML path.
      const nonce = newCspNonce();
      sendHtml(res, 404, renderRouteNotFound(pathname, { cspNonce: nonce }), nonce);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });
  configureHttpTimeouts(server, options.httpTimeouts);
  return server;
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

export function resolvePort(raw = process.env.PORT ?? "3000") {
  // Strict decimal: parseInt would silently accept "3.5" as 3 or "3000x"
  // as 3000, starting the server on a port the operator did not ask for.
  const text = String(raw).trim();
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Invalid PORT ${JSON.stringify(String(raw))}: expected an integer 1-65535`);
  }
  return port;
}

// Graceful shutdown (TOG-5726): on SIGTERM/SIGINT stop accepting new
// connections, then exit once in-flight requests drain (or after a bounded
// grace period so a stuck keep-alive cannot hold the deploy forever).
// Exported for tests; the main block below wires it to process signals.
export const SHUTDOWN_GRACE_MS = 5000;

export function installShutdownHandlers(server, options = {}) {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = options.exit ?? ((code) => process.exit(code));
  const timers = options.timers ?? { setTimeout, clearTimeout };
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, closing preview server`);
    const force = timers.setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error("graceful shutdown timed out, forcing exit");
      exit(1);
    }, graceMs);
    // A pending force-exit timer must not hold the event loop open on its
    // own once the server has drained and closed cleanly.
    force?.unref?.();
    server.close(() => {
      timers.clearTimeout(force);
      exit(0);
    });
  };
  const onSigterm = () => shutdown("SIGTERM");
  const onSigint = () => shutdown("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  return () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
}

if (isMainModule) {
  let port;
  try {
    port = resolvePort();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  }
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createApp();
  installShutdownHandlers(server);
  server.listen(port, host, () => {
    // TOG-6713: log the slowloris caps at startup so the values are visible
    // to operators without reading source (and asserted in
    // test/preview-http-timeouts.test.js).
    // eslint-disable-next-line no-console
    console.log(
      `wayselect preview server on http://${host}:${port} (preview=${isPreviewEnabled() ? "on" : "off"}) ` +
        `(headersTimeout=${server.headersTimeout}ms requestTimeout=${server.requestTimeout}ms)`,
    );
  });
}
