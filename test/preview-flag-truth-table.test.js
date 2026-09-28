// TOG-6738: WAYSELECT_PREVIEW truthiness truth table pin (test-only).
//
// Documents and pins the exact enable/disable spellings in `web/preview.js`
// (`isPreviewEnabled`, TOG-4882). Implementation: case-insensitive,
// whitespace-trimmed match against {"1", "true", "yes", "on"}; everything
// else (including unset/null/"0"/"false"/"") disables.
//
// Enabled:  "1", "true" (any case), "yes" (any case), "on" (any case),
//           with surrounding whitespace tolerated.
// Disabled: unset, null/undefined, "", whitespace-only, "0", "false",
//           "no", "off", and any other non-listed spelling.

import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isPreviewEnabled, previewFlagName } from "../web/preview.js";

describe("WAYSELECT_PREVIEW truth table (TOG-6738)", () => {
  it("exposes the expected flag name", () => {
    strictEqual(previewFlagName(), "WAYSELECT_PREVIEW");
  });

  it("enables for 1/true/yes/on spellings (case-insensitive, trimmed)", () => {
    const enabled = [
      "1",
      "true",
      "TRUE",
      "True",
      "yes",
      "YES",
      "Yes",
      "on",
      "ON",
      " On ",
      " 1 ",
      "\ttrue\n",
    ];
    for (const value of enabled) {
      strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: value }), true, JSON.stringify(value));
    }
  });

  it("disables for 0/false/''/unset and other non-listed spellings", () => {
    // Unset / nullish.
    strictEqual(isPreviewEnabled({}), false, "unset");
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: undefined }), false, "undefined");
    strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: null }), false, "null");
    const disabled = [
      "",
      "   ",
      "\t\n ",
      "0",
      " 0 ",
      "00",
      "false",
      "FALSE",
      "False",
      "no",
      "NO",
      "off",
      "OFF",
      "2",
      "enabled",
      "y",
      "t",
    ];
    for (const value of disabled) {
      strictEqual(isPreviewEnabled({ WAYSELECT_PREVIEW: value }), false, JSON.stringify(value));
    }
  });
});
