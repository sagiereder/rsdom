"use strict";
// `environment: "rsdom"`: Vitest resolves that name to this package, which is rsdom's Vitest environment
// (rsdom/vitest) with vitest's runtime imported from here.
const { createEnvironment } = require("rsdom/vitest");

module.exports = createEnvironment(async () => {
  try {
    return await import("vitest/runtime");
  } catch {
    return await import("vitest/environments");
  }
});
module.exports.default = module.exports;
