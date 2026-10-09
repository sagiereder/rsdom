"use strict";
// `testEnvironment: "rsdom"`: rsdom's Jest environment (rsdom/jest), with Jest's packages resolved from here so it
// also works under package managers that don't hoist them (pnpm, Yarn PnP).
const { createEnvironment } = require("rsdom/jest");

const RsdomEnvironment = createEnvironment(() => {
  const { installCommonGlobals } = require("jest-util");
  const { ModuleMocker } = require("jest-mock");
  const { LegacyFakeTimers, ModernFakeTimers } = require("@jest/fake-timers");
  return { installCommonGlobals, ModuleMocker, LegacyFakeTimers, ModernFakeTimers };
});

module.exports = RsdomEnvironment;
module.exports.default = RsdomEnvironment;
module.exports.TestEnvironment = RsdomEnvironment;
