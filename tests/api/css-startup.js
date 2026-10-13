"use strict";
// Tests of what makes the first getComputedStyle() of a process cheap: the precomputed default stylesheet data.
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("mocha-sugar-free");
const {
  defaultStyleSheetText,
  hashDefaultStyleSheet
} = require("../../src/jsdom/living/css/helpers/default-stylesheet.js");
const defaultStyleSheetData = require("../../src/jsdom/browser/default-stylesheet-data.json");

describe("default stylesheet data", () => {
  const regenerate = "Run `node scripts/generate-default-stylesheet-data.js` to update it.";

  it("is for the current default stylesheet", () => {
    assert.equal(defaultStyleSheetData.hash, hashDefaultStyleSheet(defaultStyleSheetText), regenerate);
  });

  it("equals the declaration blocks parsing the default stylesheet gives", { timeout: 10000 }, () => {
    // In a fresh process, since this one may have used the data already.
    const cssParserPath = path.resolve(__dirname, "../../src/jsdom/living/css/helpers/css-parser.js");
    const script = `
      const { JSDOM } = require(${JSON.stringify(path.resolve(__dirname, "../../src/api.js"))});
      const cssParser = require(${JSON.stringify(cssParserPath)});
      const cssText = require("node:fs").readFileSync(
        ${JSON.stringify(path.resolve(__dirname, "../../src/jsdom/browser/default-stylesheet.css"))},
        "utf-8"
      );
      cssParser.parseStyleSheet(cssText, new JSDOM().window);
      process.stdout.write(JSON.stringify(cssParser.getDeclarationBlockSnapshots(cssText)));
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(defaultStyleSheetData.declarationBlocks, JSON.parse(result.stdout), regenerate);
  });
});
