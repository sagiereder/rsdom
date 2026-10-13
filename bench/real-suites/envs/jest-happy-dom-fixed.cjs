"use strict";
// Jest testEnvironment: happy-dom with jest-fixed-jsdom's Node globals. See ../lib/jest-env.cjs.
const { makeJestEnvironment } = require("../lib/jest-env.cjs");

module.exports = makeJestEnvironment("happy-dom", { fixed: true });
module.exports.default = module.exports;
module.exports.TestEnvironment = module.exports;
