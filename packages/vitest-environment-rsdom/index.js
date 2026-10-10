"use strict";
// The `environment: "rsdom"` alias for @rsdom/vitest: Vitest resolves a bare environment name <name> as the package
// `vitest-environment-<name>`, which a scoped package can never match. Same code as packages/vitest/index.js, so it
// imports vitest/runtime from its own location.
const { createEnvironment } = require("@rsdom/core/vitest");

module.exports = createEnvironment(async () => {
  try {
    return await import("vitest/runtime");
  } catch {
    return await import("vitest/environments");
  }
});
module.exports.default = module.exports;
