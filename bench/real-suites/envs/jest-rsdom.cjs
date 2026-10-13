"use strict";
// Jest testEnvironment: rsdom. See ../lib/jest-env.cjs.
const { makeJestEnvironment } = require("../lib/jest-env.cjs");

module.exports = makeJestEnvironment("rsdom");
module.exports.default = module.exports;
module.exports.TestEnvironment = module.exports;
