"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cssParser = require("./css-parser.js");

const defaultStyleSheetText = fs.readFileSync(
  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),
  { encoding: "utf-8" }
);
let parsedDefaultStyleSheet;

function hashDefaultStyleSheet(cssText) {
  return crypto.createHash("sha256").update(cssText).digest("hex");
}

// What parsing the default stylesheet derives from its text alone, precomputed by
// scripts/generate-default-stylesheet-data.js, if it is up to date.
function loadPrecomputedData() {
  const data = require("../../../browser/default-stylesheet-data.json");
  return data.hash === hashDefaultStyleSheet(defaultStyleSheetText) ? data : null;
}

// Returns the parsed default (user agent) stylesheet, parsing it on first use.
//
// The parsed default stylesheet will be composed of CSSOM objects from the first global object accessed. This is a bit
// strange, but since we only ever access the internals of the returned sheet, and don't expose it to callers, it
// shouldn't cause any issues.
//
// Parsing it validates every declaration with the property parsers, whose first uses are expensive (loading and
// compiling css-tree's syntaxes, color parsing, ...). The resulting declaration blocks only depend on the stylesheet's
// text, so they are precomputed and seeded into the parser's declaration block cache, which then skips validation.
function getDefaultStyleSheet(globalObject) {
  if (parsedDefaultStyleSheet === undefined) {
    const data = loadPrecomputedData();
    if (data !== null) {
      cssParser.seedDeclarationBlocks(data.declarationBlocks);
    }
    parsedDefaultStyleSheet = cssParser.parseStyleSheet(defaultStyleSheetText, globalObject);
  }
  return parsedDefaultStyleSheet;
}

exports.defaultStyleSheetText = defaultStyleSheetText;
exports.hashDefaultStyleSheet = hashDefaultStyleSheet;
exports.getDefaultStyleSheet = getDefaultStyleSheet;
