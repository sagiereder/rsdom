"use strict";
// Differential tests of rsdom's HTML parser (html5ever, in src/native/) against parse5, the parser jsdom uses and
// rsdom used to fall back to. Every input is parsed by both, and the trees must be identical: node types, names,
// namespaces, attributes (with their namespaces and prefixes), character data, doctypes, template contents, the
// document's mode, and every node's source code location (JSDOM's includeNodeLocations), down to the attribute
// locations, end tags, and the cases where parse5 records no location (null) or never sets one (undefined).
//
// The inputs are the HTML files in this repository (outside the WPT checkout), the benchmark's generated real-world
// page, the html5lib tree-construction tests from WPT (when the WPT checkout is present), and a seeded fuzz corpus
// (fuzz.js). Fragment parsing (innerHTML) is compared too, without locations, which fragments never have.
//
// RSDOM_FUZZ_SEED and RSDOM_FUZZ_COUNT change the fuzz corpus, e.g. to search more widely than the default.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("mocha-sugar-free");
const { compareDocument, compareFragment } = require("./compare");
const { corpus } = require("./fuzz");

const ROOT = path.resolve(__dirname, "../..");
const MAX_REPORTED = 5;

const FUZZ_SEED = Number(process.env.RSDOM_FUZZ_SEED ?? 20261013);
const FUZZ_COUNT = Number(process.env.RSDOM_FUZZ_COUNT ?? 3000);

// Runs `compare` over all the cases, and fails with the first few differences. It yields to the event loop now and
// then, so that closed windows are released (which happens asynchronously) during long runs.
async function check(cases, compare) {
  const failures = [];
  let count = 0;
  for (const [i, testCase] of cases.entries()) {
    if (i % 100 === 99) {
      await new Promise(resolve => {
        setImmediate(resolve);
      });
    }
    const difference = compare(testCase);
    if (difference !== null) {
      count++;
      if (failures.length < MAX_REPORTED) {
        failures.push(`${testCase.name}\ninput: ${JSON.stringify(testCase.html)}\n${difference}`);
      }
    }
  }
  if (count > 0) {
    assert.fail(`${count} of ${cases.length} inputs parse differently:\n\n${failures.join("\n\n")}`);
  }
}

function htmlFiles(directory, skip, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (skip.has(file) || entry.name === "node_modules") {
      continue;
    }
    if (entry.isDirectory()) {
      htmlFiles(file, skip, files);
    } else if (/\.x?html?$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

// The html5lib tree-construction tests: https://github.com/html5lib/html5lib-tests/tree/master/tree-construction.
function datCases() {
  const directory = path.join(ROOT, "tests/web-platform-tests/tests/html/syntax/parsing/resources");
  if (!fs.existsSync(directory)) {
    return null;
  }
  const cases = [];
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith(".dat")).sort()) {
    const text = fs.readFileSync(path.join(directory, file), "utf8");
    for (const [index, test] of text.split(/^#data\n/m).slice(1).entries()) {
      const sections = new Map();
      let current = "#data";
      let lines = [];
      for (const line of test.split("\n")) {
        if (/^#[a-z-]+$/.test(line) && line !== current) {
          sections.set(current, lines);
          current = line;
          lines = [];
        } else {
          lines.push(line);
        }
      }
      sections.set(current, lines);
      cases.push({
        name: `${file} #${index + 1}`,
        // The data section ends with the newline before the next section.
        html: sections.get("#data").join("\n"),
        fragment: sections.has("#document-fragment") ? sections.get("#document-fragment")[0] : null,
        // Tests that run scripts (document.write) cannot be compared against a parser without a script engine.
        scripting: sections.has("#script-on") && !file.startsWith("scripted_")
      });
    }
  }
  return cases;
}

describe("Differential: rsdom's HTML parser against parse5", suite => {
  suite.timeout(600000);
  suite.slow(30000);

  it("parses the repository's HTML files identically, with source locations", () => {
    const skip = new Set([path.join(ROOT, "tests/web-platform-tests/tests")]);
    const files = [...htmlFiles(path.join(ROOT, "tests"), skip), ...htmlFiles(path.join(ROOT, "bench"), skip)];
    assert.ok(files.length > 100, `only ${files.length} HTML files found`);
    const cases = files.map(file => ({ name: path.relative(ROOT, file), html: fs.readFileSync(file, "utf8") }));
    return check(cases, ({ html }) => compareDocument(html));
  });

  it("parses the benchmark's real-world page identically, with source locations", () => {
    const [scenario] = require("../../bench/scenarios/real-page.js");
    const { html } = scenario.prepare();
    return check([{ name: scenario.name, html }], () => compareDocument(html));
  });

  it("parses the html5lib tree-construction tests identically, with source locations", t => {
    const cases = datCases();
    if (cases === null) {
      t.skip();
      return undefined;
    }
    return check(cases.filter(c => c.fragment === null), ({ html, scripting }) => compareDocument(html, { scripting }));
  });

  it("parses the html5lib tree-construction fragment tests identically", t => {
    const cases = datCases();
    if (cases === null) {
      t.skip();
      return undefined;
    }
    // Fragment parsing always has scripting disabled in jsdom (fragments never run scripts).
    return check(
      cases.filter(c => c.fragment !== null && !c.scripting),
      ({ html, fragment }) => compareFragment(html, fragment)
    );
  });

  it(`parses ${FUZZ_COUNT} fuzzed documents (seed ${FUZZ_SEED}) identically, with source locations`, () => {
    const cases = corpus(FUZZ_SEED, FUZZ_COUNT).map((html, i) => ({ name: `fuzz #${i}`, html }));
    return check(cases, ({ html }) => compareDocument(html));
  });

  it(`parses ${Math.ceil(FUZZ_COUNT / 3)} fuzzed documents identically with scripting enabled`, () => {
    const cases = corpus(FUZZ_SEED + 1, Math.ceil(FUZZ_COUNT / 3)).map((html, i) => ({ name: `fuzz #${i}`, html }));
    return check(cases, ({ html }) => compareDocument(html, { scripting: true }));
  });

  it(`parses ${FUZZ_COUNT} fuzzed fragments identically, in various contexts`, () => {
    const contexts = [
      "body", "div", "html", "head", "table", "tbody", "tr", "td", "caption", "colgroup", "select", "template",
      "textarea", "title", "script", "style", "plaintext", "noscript", "frameset", "svg svg", "svg foreignObject",
      "svg desc", "math math", "math mi", "math annotation-xml"
    ];
    const cases = corpus(FUZZ_SEED + 2, FUZZ_COUNT).map((html, i) => ({
      name: `fuzz #${i} in ${contexts[i % contexts.length]}`,
      html,
      context: contexts[i % contexts.length]
    }));
    return check(cases, ({ html, context }) => compareFragment(html, context));
  });
});
