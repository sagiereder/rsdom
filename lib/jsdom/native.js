"use strict";
const path = require("node:path");

// The Rust addon (native/) accelerates hot paths. JSDOM_NATIVE=0 forces the pure-JS fallbacks.
let native = null;
if (process.env.JSDOM_NATIVE !== "0") {
  try {
    native = require(path.resolve(__dirname, "../../native/jsdom-native.node"));
  } catch {
    native = null;
  }
}

module.exports = native;
