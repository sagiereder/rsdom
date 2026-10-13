"use strict";
// Kept out of jsdom-dispatcher.js so that code which only needs the default user agent string does not load undici.
const packageVersion = require("../../../../package.json").version;

module.exports = `Mozilla/5.0 (${process.platform || "unknown OS"}) AppleWebKit/537.36 ` +
                 `(KHTML, like Gecko) jsdom/${packageVersion}`;
