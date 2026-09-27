// Strict JSON request-body reader for future Wayselect preview POST routes
// (TOG-5476, S3 slice of the TOG-5465 §4 preview security checklist).
//
// Seller-acceptance O8 (`docs/wayselect-seller-acceptance.md`) requires the
// future offer POST routes to cap the request body (~64KB), enforce strict
// `Content-Type: application/json`, and fail closed with 400 on malformed
// JSON. This module is the reusable gate those routes must call before any
// validator runs; it is pure transport plumbing (no domain knowledge), so it
// returns a neutral result and the route maps failures onto its own error
// envelope (e.g. `{error:"invalid_offer"}` for offers).
//
// Contract:
//   const result = await readJsonBody(req);
//   if (!result.ok) → respond 400 (or 413 for `body_too_large`) with the
//     route's error name; `result.code` is one of `wrong_content_type`,
//     `body_too_large`, `malformed_json`. Never log `result` detail beyond
//     the code: the raw bytes stay out of logs.
//   if (result.ok) → `result.value` is the parsed JSON value.
//
// Zero dependencies: Node built-in http request stream only.

import { MAX_JSON_BODY_BYTES } from "../src/intakeLimits.js";

export const JSON_MEDIA_TYPE = "application/json";

function mediaType(contentType) {
  if (typeof contentType !== "string") {
    return null;
  }
  return contentType.split(";")[0].trim().toLowerCase() || null;
}

export function isJsonContentType(contentType) {
  return mediaType(contentType) === JSON_MEDIA_TYPE;
}

// Reads and strict-parses a JSON request body. Resolves (never rejects)
// with `{ok:true, value}` or `{ok:false, code, detail}`. Drains the stream
// on oversize so the socket stays reusable; callers must not read `req`
// again afterwards either way.
export function readJsonBody(req, options = {}) {
  const maxBytes =
    options.maxBytes === undefined ? MAX_JSON_BODY_BYTES : options.maxBytes;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new TypeError("options.maxBytes must be a non-negative number when present");
  }

  if (!isJsonContentType(req.headers?.["content-type"])) {
    return Promise.resolve({
      ok: false,
      code: "wrong_content_type",
      detail: `Content-Type must be ${JSON_MEDIA_TYPE}`,
    });
  }

  // Fail fast on a lying-or-huge declared length before reading the stream.
  const declared = req.headers?.["content-length"];
  if (declared !== undefined) {
    const length = Number.parseInt(String(declared).trim(), 10);
    if (!Number.isInteger(length) || length < 0) {
      return Promise.resolve({
        ok: false,
        code: "malformed_json",
        detail: "Content-Length must be a non-negative integer",
      });
    }
    if (length > maxBytes) {
      req.resume?.();
      return Promise.resolve({
        ok: false,
        code: "body_too_large",
        detail: `request body exceeds ${maxBytes} bytes`,
      });
    }
  }

  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      received += chunk.length;
      if (received > maxBytes) {
        settle({ ok: false, code: "body_too_large", detail: `request body exceeds ${maxBytes} bytes` });
        req.resume?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        settle({ ok: true, value: JSON.parse(text) });
      } catch {
        settle({ ok: false, code: "malformed_json", detail: "request body is not valid JSON" });
      }
    });
    req.on("error", () => {
      settle({ ok: false, code: "malformed_json", detail: "request body could not be read" });
    });
  });
}
