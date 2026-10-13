"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { describe, it } = require("mocha-sugar-free");

// rsdom runs on either build of its Rust core: the native addon or the WebAssembly build (see src/jsdom/native.js).
// The rest of the suite tests whichever build loads (or JSDOM_NATIVE selects); this runs the same inputs through each
// build in a child process, so that a difference between the builds fails the suite in either mode.
const fixture = path.resolve(__dirname, "fixtures/rust-core-build.js");

function runWith(build) {
  const env = { ...process.env, JSDOM_NATIVE: build };
  const { status, stdout, stderr } = spawnSync(process.execPath, [fixture], { env, encoding: "utf-8" });
  if (status === 3) {
    return null;
  }
  assert.equal(status, 0, `the fixture failed with JSDOM_NATIVE=${build}:\n${stderr}`);
  return JSON.parse(stdout);
}

describe("Rust core builds", { slow: 2000 }, () => {
  const results = new Map();
  function resultsFor(build, t) {
    if (!results.has(build)) {
      results.set(build, runWith(build));
    }
    const result = results.get(build);
    if (result === null) {
      // The build is not available (in a development checkout, it has not been built). t.skip() throws.
      t.skip();
    }
    return result;
  }

  for (const build of ["native", "wasm"]) {
    it(`parses XML and HTML with the ${build} build`, t => {
      const r = resultsFor(build, t);
      assert.equal(r.smallXML, `<root xmlns:p="urn:p"><p:a x="1">text<b/></p:a><!--c--><?pi data?></root>`);
      assert.deepEqual(r.largeXML, { localName: "list", children: 5000, last: `<item n="4999">value 4999</item>` });
      assert.equal(r.xmlFragment, `<root xmlns="urn:x"><a><b c="d"/>e</a><f/></root>`);
      assert.equal(r.domParser, `<a><b>x</b></a>`);
      assert.deepEqual(r.xmlBytes, ["UTF-8", `<a>café</a>`]);
      assert.equal(r.htmlLocations[0], `<!DOCTYPE html><html><head></head><body><table><tbody><tr><td>x</td></tr>` +
        `</tbody></table><p id="p">hi</p></body></html>`);
      assert.deepEqual(r.htmlLocations[1], {
        startLine: 1, startCol: 40, startOffset: 39, endLine: 1, endCol: 50, endOffset: 49,
        attrs: { id: { startLine: 1, startCol: 43, startOffset: 42, endLine: 1, endCol: 47, endOffset: 46 } },
        startTag: {
          startLine: 1, startCol: 40, startOffset: 39, endLine: 1, endCol: 48, endOffset: 47,
          attrs: { id: { startLine: 1, startCol: 43, startOffset: 42, endLine: 1, endCol: 47, endOffset: 46 } }
        }
      });
      assert.equal(r.htmlScripts, `<html><head></head><body><p>a<script>document.write("<b>b</b>")</script>` +
        `<b>b</b>c</p></body></html>`);
      assert.equal(r.htmlFragment, 1);
      assert.deepEqual(r.htmlBytes, ["ISO-8859-5", "щ"]);
    });
  }

  it("gives the same results with both builds", t => {
    assert.deepEqual(resultsFor("wasm", t), resultsFor("native", t));
  });
});
