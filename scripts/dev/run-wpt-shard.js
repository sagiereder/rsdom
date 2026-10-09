"use strict";
/* eslint-disable func-style, @stylistic/max-len */
// Mocha entry point like tests/web-platform-tests/run-wpts.js, but restricted to the WPT directories
// listed in WPT_DIRS (comma-separated, prefix match). Used by scripts/dev/test.js for sharded/selective runs.
const path = require("node:path");
const { describe, before, after } = require("mocha-sugar-free");
const wptDir = path.resolve(__dirname, "../../tests/web-platform-tests");
const { readManifest, getPossibleTestFilePaths } = require(path.join(wptDir, "wpt-manifest-utils.js"));
const wptServer = require(path.join(wptDir, "wpt-server.js"));
const { getURLPrefix, killSubprocess } = require(path.join(wptDir, "utils.js"));
const { checkToRunFile, runTestWithExpectations } = require(path.join(wptDir, "expectations-utils.js"));

const manifest = readManifest(path.join(wptDir, "wpt-manifest.json"));
const possibleTestFilePaths = getPossibleTestFilePaths(manifest);
const toRunFilename = "to-run.yaml";
const wanted = (process.env.WPT_DIRS || "").split(",").map(s => s.trim()).filter(Boolean);
const matches = dir => wanted.length === 0 || wanted.some(w => dir === w || dir.startsWith(w + "/") || w.startsWith(dir + "/"));
const fileFilter = (dir, testPath) => wanted.length === 0 ||
  wanted.some(w => w === dir || dir.startsWith(w + "/") || testPath.startsWith(w));

const testGroups = checkToRunFile(path.join(wptDir, toRunFilename), possibleTestFilePaths);

let wptServerURLs, serverProcess;
const runSingleWPT = require(path.join(wptDir, "run-single-wpt.js"))(
  testPath => getURLPrefix(wptServerURLs, testPath),
  toRunFilename
);
before({ timeout: 30_000 }, async () => {
  const { urls, subprocess } = await wptServer.start({ toUpstream: false });
  wptServerURLs = urls;
  serverProcess = subprocess;
});
after({ timeout: 5000 }, () => killSubprocess(serverProcess));

describe("web-platform-tests", () => {
  for (const { dir, expectationDataByTestFilePath, testFilePaths } of testGroups) {
    if (!matches(dir)) {
      continue;
    }
    describe(dir, () => {
      for (const testFilePath of testFilePaths) {
        if (!fileFilter(dir, testFilePath)) {
          continue;
        }
        runTestWithExpectations(testFilePath, expectationDataByTestFilePath, { runSingleWPT, prefix: dir + "/" });
      }
    });
  }
});
