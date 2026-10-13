"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("mocha-sugar-free");

const apiPath = path.resolve(__dirname, "../../src/api.js");

// Runs `body` in a fresh Node.js process (this one has already loaded everything) and returns the modules it loaded.
function modulesLoadedBy(body) {
  const script = `
    const { JSDOM } = require(${JSON.stringify(apiPath)});
    ${body}
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function isInPackage(name) {
  const dir = `${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}${path.sep}`;
  return file => file.includes(dir);
}

const isUndici = isInPackage("undici");

describe("lazy loading", () => {
  it("does not load undici for a document that never fetches anything", () => {
    const loaded = modulesLoadedBy(`
      const dom = new JSDOM("<!doctype html><p>hi</p>", { url: "https://example.com/" });
      const { window } = dom;
      window.getComputedStyle(window.document.querySelector("p")).color;
      new window.XMLHttpRequest();
    `);
    assert.deepEqual(loaded.filter(isUndici), []);
  });

  it("loads undici once the dispatcher is needed", () => {
    const loaded = modulesLoadedBy(`
      const dom = new JSDOM("", { url: "https://example.com/" });
      dom.window._settings.dispatcher;
    `);
    assert.ok(loaded.some(isUndici));
  });
});

describe("lazy loading of CSS dependencies", () => {
  it("does not load dom-selector for getComputedStyle()", { timeout: 10000 }, () => {
    const loaded = modulesLoadedBy(`
      const dom = new JSDOM("<!doctype html><style>p:focus { color: red; }</style><p>hi</p>");
      const { window } = dom;
      window.getComputedStyle(window.document.body).display;
      window.getComputedStyle(window.document.querySelector("p")).color;
    `);
    assert.deepEqual(loaded.filter(isInPackage("@asamuzakjp/dom-selector")), []);
  });
});
