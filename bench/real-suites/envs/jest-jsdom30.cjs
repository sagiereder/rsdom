"use strict";
// Jest testEnvironment: jsdom30. See ../lib/jest-env.cjs.
const { makeJestEnvironment } = require("../lib/jest-env.cjs");

module.exports = makeJestEnvironment("jsdom30");
module.exports.default = module.exports;
module.exports.TestEnvironment = module.exports;
