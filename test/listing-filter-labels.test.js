// Tests for TOG-6038: filter-form label association + keyboard operability
// audit (node:test, zero dependencies).
//
// Gap A1 (part 1): landmarks are pinned by `test/listing-a11y.test.js` but no
// test asserted that every filter control has an associated label, or that
// every control is reachable/operable by keyboard alone. This file pins both:
//   - every `<input>` in the filter form carries an `id` with a matching
//     `<label for="…">` (explicit association, on top of the wrapping label),
//     ids are unique, and every label has visible (non-empty) text;
//   - every form control is a natively keyboard-operable element
//     (`input`/`button`/`a`): no `tabindex` overrides, no div/span-buttons,
//     nothing disabled, with `:focus-visible` styles covering inputs;
//   - the groups keep their `<legend>` names and the form keeps its
//     accessible name (`role="search"` + `aria-label`).
// The audit covers the populated, active-filter, and empty-result renders.

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { VALID_CAPABILITIES, VALID_MODALITIES, emptyFilters } from "../web/filter.js";
import { renderListingIndex } from "../web/listing-detail.js";
import { STUB_LISTINGS } from "../web/stub-listing.js";

function filterForm(html) {
  const start = html.indexOf("<form");
  const end = html.indexOf("</form>");
  ok(start !== -1 && end !== -1, "filter form rendered");
  return html.slice(start, end + "</form>".length);
}

function inputTags(form) {
  return [...form.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
}

function attr(tag, name) {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

// Every label's visible text: strip the nested control markup, keep text.
function labelEntries(form) {
  return [...form.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map((match) => ({
    forId: match[1].match(/for="([^"]*)"/)?.[1] ?? null,
    // Case-insensitive strip (CodeQL incomplete-multi-character-sanitization,
    // same fix as ca1873e): an uppercase tag must not survive the strip.
    text: match[2].replaceAll(/<[^>]+>/gi, "").trim(),
  }));
}

describe("filter form label association (TOG-6038)", () => {
  it("gives every input an id with a matching label for", () => {
    const form = filterForm(renderListingIndex(STUB_LISTINGS, undefined, emptyFilters()));
    const inputs = inputTags(form);
    strictEqual(inputs.length, 1 + VALID_CAPABILITIES.length + VALID_MODALITIES.length);
    const labels = labelEntries(form);
    const seen = new Set();
    for (const tag of inputs) {
      const id = attr(tag, "id");
      ok(id, `input has id: ${tag}`);
      ok(!seen.has(id), `id unique: ${id}`);
      seen.add(id);
      ok(
        labels.some((label) => label.forId === id),
        `label for="${id}" present`,
      );
    }
  });

  it("keeps explicit label association with active filters reflected", () => {
    const form = filterForm(
      renderListingIndex(STUB_LISTINGS, undefined, {
        q: "alpha",
        capabilities: ["tool_call"],
        modalities: ["image"],
      }),
    );
    const inputs = inputTags(form);
    for (const tag of inputs) {
      const id = attr(tag, "id");
      ok(id && form.includes(`for="${id}"`), `label for="${id}" kept with active filters`);
    }
    ok(form.includes('value="alpha"'), "active q reflected");
    ok(form.includes('value="tool_call" checked'), "active capability checked");
  });

  it("gives every label non-empty visible text and names every value", () => {
    const form = filterForm(renderListingIndex(STUB_LISTINGS, undefined, emptyFilters()));
    const labels = labelEntries(form);
    strictEqual(labels.length, inputTags(form).length, "one label per control");
    for (const label of labels) {
      ok(label.text.length > 0, `label for="${label.forId}" has visible text`);
    }
    const visible = labels.map((label) => label.text).join(" | ");
    ok(visible.includes("Search"), "search label visible");
    for (const name of ["Attachments", "Reasoning", "Tool calls", "Structured output"]) {
      ok(visible.includes(name), `capability label visible: ${name}`);
    }
    for (const name of VALID_MODALITIES) {
      ok(visible.includes(name), `modality label visible: ${name}`);
    }
  });

  it("keeps the filter form labelled on the empty-result page", () => {
    const form = filterForm(renderListingIndex([], undefined, emptyFilters()));
    strictEqual(inputTags(form).length, 1 + VALID_CAPABILITIES.length + VALID_MODALITIES.length);
    for (const tag of inputTags(form)) {
      const id = attr(tag, "id");
      ok(id && form.includes(`for="${id}"`), `label for="${id}" on empty page`);
    }
  });
});

describe("filter form keyboard operability (TOG-6038)", () => {
  it("uses only natively keyboard-operable controls with no tab-order overrides", () => {
    const form = filterForm(renderListingIndex(STUB_LISTINGS, undefined, emptyFilters()));
    const controls = [...form.matchAll(/<(input|button|select|textarea|a)\b/g)].map((m) => m[1]);
    // 10 inputs + Apply submit button + Clear filters link.
    strictEqual(controls.length, 12, `all controls native, got: ${controls.join(",")}`);
    ok(!form.includes("tabindex"), "no tab-order overrides");
    ok(!form.includes("disabled"), "no disabled controls");
    ok(!form.includes('role="button"'), "no div/span pseudo-buttons");
    ok(form.includes('<button type="submit">Apply filters</button>'), "named submit");
    ok(form.includes('<a href="/listings">Clear filters</a>'), "named clear link");
  });

  it("groups controls under named legends with an accessible form name", () => {
    const form = filterForm(renderListingIndex(STUB_LISTINGS, undefined, emptyFilters()));
    ok(form.includes('role="search"'), "search landmark role");
    ok(form.includes('aria-label="Filter listings"'), "accessible form name");
    ok(form.includes("<legend>Capabilities</legend>"), "capabilities group name");
    ok(form.includes("<legend>Modalities</legend>"), "modalities group name");
  });

  it("covers filter controls with visible focus styles", () => {
    const html = renderListingIndex(STUB_LISTINGS, undefined, emptyFilters());
    ok(html.includes("input:focus-visible"), "focus ring on inputs");
    ok(html.includes("button:focus-visible"), "focus ring on submit");
    ok(html.includes("(forced-colors: active)"), "high-contrast fallback kept");
  });
});
