"use strict";
// Tests of what makes the first getComputedStyle() of a process cheap: the precomputed default stylesheet data, and not
// creating dom-selector's DOMSelector for it (see dom-selector-events.js).
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("mocha-sugar-free");
const { JSDOM } = require("../..");
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

describe(":focus-visible after getComputedStyle()", () => {
  // Runs steps in two documents: one where getComputedStyle() of the active element is the first thing that checks a
  // :focus-visible selector, and one where a selector check that needs dom-selector (and creates its DOMSelector) comes
  // first, as getComputedStyle() used to do. Everything page code can observe must be the same.
  function run(steps) {
    const dom = new JSDOM(`<!doctype html><style>button:focus-visible { color: red; }</style>
      <button id="b">b</button><input id="i"><div id="d"></div>`);
    const { window } = dom;
    const { document } = window;
    const observed = [];
    const originalAddEventListener = window.addEventListener;
    function spy(type, ...args) {
      observed.push(`addEventListener ${type}`);
      return originalAddEventListener.call(this, type, ...args);
    }
    window.addEventListener = spy;

    const context = {
      window,
      document,
      key(type, key) {
        document.activeElement.dispatchEvent(new window.KeyboardEvent(type, { key, bubbles: true }));
      },
      mouse(type, element) {
        element.dispatchEvent(new window.MouseEvent(type, { bubbles: true }));
      },
      observe() {
        for (const id of ["b", "i"]) {
          const element = document.getElementById(id);
          observed.push(`${id} ${element.matches(":focus-visible")} ${window.getComputedStyle(element).color}`);
        }
      }
    };
    for (const step of steps) {
      step(context);
    }
    observed.push(`own addEventListener ${window.addEventListener === spy}`);
    window.close();
    return observed;
  }

  function viaComputedStyle({ window, document }) {
    window.getComputedStyle(document.activeElement).getPropertyValue("color");
  }
  // :focus-visible:not(#x) is checked by dom-selector, which creates the DOMSelector.
  function viaDOMSelector({ document }) {
    document.activeElement.matches(":focus-visible:not(#x)");
  }

  const scenarios = {
    "keyboard event, then focus": [
      c => c.key("keydown", "a"),
      c => c.document.getElementById("b").focus(),
      c => c.observe()
    ],
    "modifier key, then focus": [
      c => c.key("keydown", "Shift"),
      c => c.document.getElementById("b").focus(),
      c => c.observe()
    ],
    "mouse event, then focus": [
      c => c.mouse("mousedown", c.document.getElementById("b")),
      c => c.mouse("mouseup", c.document.getElementById("b")),
      c => c.document.getElementById("b").focus(),
      c => c.observe()
    ],
    "focus, then keyboard event": [
      c => c.document.getElementById("i").focus(),
      c => c.key("keyup", "Tab"),
      c => c.observe(),
      c => c.document.getElementById("b").focus(),
      c => c.observe()
    ],
    "keyboard event, then mouse event": [
      c => c.key("keydown", "a"),
      c => c.mouse("click", c.document.getElementById("d")),
      c => c.document.getElementById("b").focus(),
      c => c.observe()
    ]
  };

  for (const [name, steps] of Object.entries(scenarios)) {
    it(name, () => {
      const expected = run([viaDOMSelector, ...steps]);
      assert.equal(expected[0], "addEventListener focus");
      assert.deepEqual(run([viaComputedStyle, ...steps]), expected);
      // Also when the DOMSelector is created between the events, rather than when observing.
      for (let i = 1; i < steps.length; ++i) {
        const withSelectorCheck = [...steps.slice(0, i), viaDOMSelector, ...steps.slice(i)];
        assert.deepEqual(
          run([viaComputedStyle, ...withSelectorCheck]),
          run([viaDOMSelector, ...withSelectorCheck])
        );
      }
    });
  }
});
