// TOG-7311: pin the user-visible copy of an aborted detail fragment.
//
// Server timer cleanup landed in #126 (TOG-6714, pinned by
// test/detail-fragment-abort.test.js): an aborted delayed fragment leaves
// zero pending timers. This file pins the other half — what the user SEES
// when that delayed fragment aborts.
//
// The shell's inline fetch has no AbortError branch, so an aborted fragment
// request rejects into the same `.catch` as any fetch failure: the
// `role="alert"` error panel unhides with the failure copy, the
// `role="status"` announcer carries the same words, `aria-busy` clears, and
// focus moves to Retry (which re-issues the same fragment request). The
// delay knob only changes timing, never copy.
//
// node:test, stdlib only. `node:vm` executes the real inline script
// extracted from the rendered shell against a stub document; the fetch stub
// rejects with an abort-shaped DOMException. Script extraction uses indexOf
// (TOG-6049/TOG-6028 CodeQL-safe precedent: no tag-strip replace).

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetailShell } from "../web/listing-detail.js";

// The aborted-state copy in both encodings the shell carries: the panel
// paragraph is HTML-entity-encoded, the script announce string is raw UTF-8
// (U+2019 RIGHT SINGLE QUOTATION MARK). The only difference between the two
// is that apostrophe encoding — pinned by the tail assertion below.
const PANEL_COPY =
  "<p>Couldn&rsquo;t load listing details. Check your connection and retry.</p>";
const ANNOUNCE_COPY = "Couldn’t load listing details. Check your connection and retry.";
const SHARED_TAIL = " load listing details. Check your connection and retry.";

function shellHtml() {
  return renderListingDetailShell(getStubListing("northstar", "alpha-chat"));
}

// Extract the single inline script body. Sound: the renderer emits exactly
// one <script> block (bare tag in tests — no cspNonce passed).
function scriptSource(html) {
  const open = html.indexOf("<script");
  ok(open !== -1, "inline script present");
  const bodyStart = html.indexOf(">", open) + 1;
  const bodyEnd = html.indexOf("</script>", bodyStart);
  ok(bodyEnd !== -1, "inline script closed");
  ok(html.indexOf("</script>", bodyEnd + 1) === -1, "exactly one script block");
  return html.slice(bodyStart, bodyEnd);
}

function stubElement() {
  return {
    hidden: false,
    textContent: "",
    attrs: {},
    focused: false,
    listeners: [],
    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },
    focus() {
      this.focused = true;
    },
    addEventListener(type, fn) {
      this.listeners.push([type, fn]);
    },
    replaceChildren() {},
  };
}

// Runs the real shell script with a fetch stub that rejects like an
// aborted request, then returns the stub DOM for assertions.
async function runAbortedShell() {
  const html = shellHtml();
  const source = scriptSource(html);
  const elements = {
    "listing-detail": stubElement(),
    "listing-detail-status": stubElement(),
    "listing-detail-error": stubElement(),
    "listing-detail-retry": stubElement(),
  };
  const fetchCalls = [];
  const abortError =
    typeof DOMException === "function"
      ? new DOMException("The operation was aborted.", "AbortError")
      : Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  const sandbox = {
    document: {
      getElementById: (id) => elements[id] ?? null,
      createElement: () => ({ innerHTML: "", content: { cloneNode: () => ({}) } }),
    },
    fetch: (url, opts) => {
      fetchCalls.push([url, opts]);
      return Promise.reject(abortError);
    },
  };
  vm.runInNewContext(source, sandbox);
  // Let the rejection travel through .then/.catch to the DOM updates.
  await new Promise((resolve) => setTimeout(resolve, 25));
  return { elements, fetchCalls };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("detail-fragment aborted-state copy (TOG-7311)", () => {
  it("shows the failure copy when the fragment fetch aborts", async () => {
    const { elements, fetchCalls } = await runAbortedShell();
    // The abort exercised the real fragment request (same-origin JSON).
    strictEqual(fetchCalls.length, 1, "one fragment request issued");
    strictEqual(fetchCalls[0][0], "/listings/northstar/alpha-chat", "fragment route");
    strictEqual(fetchCalls[0][1]?.headers?.accept, "application/json", "fragment negotiates JSON");
    // The user-visible aborted state: announcer + panel + busy + focus.
    strictEqual(
      elements["listing-detail-status"].textContent,
      ANNOUNCE_COPY,
      "status announces the failure copy",
    );
    strictEqual(elements["listing-detail-error"].hidden, false, "error panel unhidden");
    strictEqual(elements["listing-detail"].attrs["aria-busy"], "false", "busy state cleared");
    strictEqual(elements["listing-detail-retry"].focused, true, "focus moved to Retry");
  });

  it("re-issues the fragment request on Retry and keeps the copy", async () => {
    const { elements, fetchCalls } = await runAbortedShell();
    const retry = elements["listing-detail-retry"];
    const click = retry.listeners.find(([type]) => type === "click")?.[1];
    ok(click, "retry click wired");
    // Reset focus to prove the second failure re-focuses.
    retry.focused = false;
    click();
    await settle();
    strictEqual(fetchCalls.length, 2, "retry re-issues the fragment request");
    strictEqual(
      elements["listing-detail-status"].textContent,
      ANNOUNCE_COPY,
      "copy persists after retry",
    );
    strictEqual(elements["listing-detail-retry"].focused, true, "retry re-focused");
  });

  it("keeps the error panel copy byte-identical in the served shell", () => {
    const html = shellHtml();
    ok(html.includes('id="listing-detail-error" role="alert" hidden'), "alert panel starts hidden");
    ok(html.includes(PANEL_COPY), "panel paragraph copy pinned");
    ok(
      html.indexOf('id="listing-detail-error"') < html.indexOf(PANEL_COPY),
      "copy lives inside the alert panel",
    );
    ok(html.includes('id="listing-detail-retry">Retry<'), "retry control labelled");
  });

  it("routes every abort through the single failure sink with matching copy", () => {
    const source = scriptSource(shellHtml());
    // AbortError has no dedicated branch: a fetch abort rejects into .catch.
    ok(!source.includes("AbortError"), "no abort special-case to drift");
    strictEqual(source.split(".catch(").length - 1, 1, "one rejection sink");
    ok(source.includes(`announce("${ANNOUNCE_COPY}")`), "announce copy pinned");
    // Panel and announcer agree word-for-word past the apostrophe encoding.
    ok(PANEL_COPY.endsWith(`${SHARED_TAIL}</p>`), "panel tail pinned");
    ok(ANNOUNCE_COPY.endsWith(SHARED_TAIL), "announcer tail pinned");
  });
});
