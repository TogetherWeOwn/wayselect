// Tests for TOG-6394: WCAG AA color-contrast evidence for the
// eligibility/capability badge classes shipped in web/listing-detail.js.
//
// All five badge foreground/background pairs clear AA (>= 4.5 for normal
// text — badges render at 0.85rem, so the normal-text threshold applies)
// and in fact clear AAA (>= 7.0). Colors are read out of the shipped
// <style> block in the rendered page, not hardcoded as pairs, so a future
// restyle that drops below AA fails loudly. Measured 2026-09-27 (WCAG 2.x):
//   badge-on / badge-granted  #1a4d1f on #d3f9d8  8.62
//   badge-off                 #495057 on #f1f3f5  7.35
//   badge-blocked             #7a1f1f on #ffe3e3  8.49
//   badge-unknown             #5c4a00 on #fff3bf  7.73
// (node:test, stdlib + repo modules only; offline like the rest of the suite.)

import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { getStubListing } from "../web/stub-listing.js";
import { renderListingDetail } from "../web/listing-detail.js";

// Style-block extraction without tag-stripping replacements (TOG-5717
// CodeQL-safe precedent in test/listing-a11y.test.js): the renderer emits
// exactly one <style> block, located with indexOf — pure extraction, no
// replacement, no HTML-matching regexp.
function styleBlock(html) {
  const open = html.indexOf("<style");
  ok(open !== -1, "shipped <style> block present");
  const openEnd = html.indexOf(">", open);
  const close = html.indexOf("</style>", openEnd);
  ok(openEnd !== -1 && close !== -1, "shipped <style> block closed");
  return html.slice(openEnd + 1, close);
}

function isHexDigit(ch) {
  return "0123456789abcdefABCDEF".includes(ch);
}

// Read the `background` / `color` hex values out of one `.badge-x { ... }`
// rule with plain indexOf slicing (same precedent as above: no regexps).
function ruleColors(css, cls) {
  const open = css.indexOf(`.${cls} {`);
  ok(open !== -1, `${cls} rule present in shipped CSS`);
  const close = css.indexOf("}", open);
  ok(close !== -1, `${cls} rule closed`);
  const rule = css.slice(open, close);
  return {
    background: hexAfter(rule, cls, "background:"),
    foreground: hexAfter(rule, cls, "color:"),
  };
}

function hexAfter(rule, cls, prop) {
  const at = rule.indexOf(prop);
  ok(at !== -1, `${cls}: ${prop} present`);
  const hash = rule.indexOf("#", at);
  const hex = rule.slice(hash, hash + 7);
  ok(hex.length === 7 && hex.startsWith("#"), `${cls}: ${prop} is a hex color`);
  for (const ch of hex.slice(1)) {
    ok(isHexDigit(ch), `${cls}: ${prop} hex digit ${ch}`);
  }
  return hex;
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fg, bg) {
  const hi = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const lo = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

// TOG-6394 measured ratios (WCAG 2.x, rounded to 2dp). badge-on and
// badge-granted share one palette, pinned once each.
const EXPECTED = {
  "badge-on": "8.62",
  "badge-off": "7.35",
  "badge-granted": "8.62",
  "badge-blocked": "8.49",
  "badge-unknown": "7.73",
};

describe("badge color contrast (TOG-6394)", () => {
  it("every badge pair meets WCAG AA (>= 4.5) with pinned ratios", () => {
    const html = renderListingDetail(getStubListing("northstar", "alpha-chat"));
    const css = styleBlock(html);
    for (const [cls, pinned] of Object.entries(EXPECTED)) {
      const { background, foreground } = ruleColors(css, cls);
      const ratio = contrastRatio(foreground, background);
      ok(
        ratio >= 4.5,
        `${cls}: ${foreground} on ${background} = ${ratio.toFixed(2)} meets WCAG AA`,
      );
      strictEqual(ratio.toFixed(2), pinned, `${cls}: measured ratio pinned`);
    }
  });
});
