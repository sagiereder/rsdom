"use strict";
// Jest testEnvironment: happy-dom. See ../lib/jest-env.cjs.
const { makeJestEnvironment } = require("../lib/jest-env.cjs");

module.exports = makeJestEnvironment("happy-dom");
module.exports.default = module.exports;
module.exports.TestEnvironment = module.exports;
