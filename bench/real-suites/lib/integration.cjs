"use strict";
// Loads rsdom's Jest or Vitest integration (src/integrations/{jest,vitest}.js), either as is (impl "rsdom") or with
// jsdom 30.1.2 from npm in place of rsdom (impl "jsdom30"). rsdom is a fork of jsdom 30.1.2, so jsdom30 runs the
// exact same environment code on the upstream library: any test that passes there and fails on rsdom is an rsdom
// compatibility bug, while differences between a project's own (often older) jsdom and jsdom30 are jsdom version
// changes.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const UPSTREAM_DIR = path.dirname(require.resolve("jsdom-upstream/package.json"));

function loadIntegration(kind, impl) {
  const file = path.join(REPO_ROOT, "src/integrations", `${kind}.js`);
  if (impl === "rsdom") {
    if (!require(path.join(REPO_ROOT, "src/jsdom/native.js"))) {
      throw new Error("rsdom's native addon did not load; the real-suite benchmark only measures the native build");
    }
    return require(file);
  }
  if (impl !== "jsdom30") {
    throw new Error(`no integration for ${impl}`);
  }
  const redirects = {
    "../api.js": path.join(UPSTREAM_DIR, "lib/api.js"),
    "../generated/idl/utils.js": path.join(UPSTREAM_DIR, "lib/generated/idl/utils.js")
  };
  const mod = new Module(`${file}#jsdom30`, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = mod.require.bind(mod);
  mod.require = id => originalRequire(redirects[id] ?? id);
  mod._compile(fs.readFileSync(file, "utf8"), file);
  return mod.exports;
}

module.exports = { loadIntegration };
