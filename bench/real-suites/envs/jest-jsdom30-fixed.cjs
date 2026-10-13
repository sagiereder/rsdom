"use strict";
// Jest testEnvironment: jsdom30 with jest-fixed-jsdom's Node globals. See ../lib/jest-env.cjs.
const { makeJestEnvironment } = require("../lib/jest-env.cjs");

module.exports = makeJestEnvironment("jsdom30", { fixed: true });
module.exports.default = module.exports;
module.exports.TestEnvironment = module.exports;
