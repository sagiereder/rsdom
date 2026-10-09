"use strict";
// rsdom's Vitest environment (@rsdom/core/vitest), with vitest's runtime imported from here. Vitest only resolves bare
// environment names as `vitest-environment-<name>`, so a scoped package has to be given as a path:
// `environment: "./node_modules/@rsdom/vitest"`.
const { createEnvironment } = require("@rsdom/core/vitest");

module.exports = createEnvironment(async () => {
  try {
    return await import("vitest/runtime");
  } catch {
    return await import("vitest/environments");
  }
});
module.exports.default = module.exports;
