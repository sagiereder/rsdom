"use strict";

// css-tree, forked with the csstools syntax patches. Loading and forking it takes tens of milliseconds, which every
// process (e.g. every Vitest test file) would pay up front even if it never parses CSS, so it is done on first use:
// this module's members start out as getters that load the fork, then replace themselves with its members.

// The members of the forked API (csstree.fork()), plus the standalone utilities re-exported below.
const MEMBERS = [
  "lexer", "createLexer", "tokenize", "parse", "generate", "walk", "find", "findLast", "findAll", "fromPlainObject",
  "toPlainObject", "fork", "string", "ident"
];

function load() {
  const { next: syntaxes } = require("@csstools/css-syntax-patches-for-csstree");
  const csstree = require("css-tree");

  // fork() only returns the core parse/generate/walk API, dropping standalone utilities like string, url,
  // ident, tokenTypes, etc. Re-export the ones we need.
  const forked = csstree.fork(syntaxes);
  forked.string = csstree.string;
  forked.ident = csstree.ident;

  for (const member of MEMBERS) {
    Object.defineProperty(exports, member, {
      value: forked[member],
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
}

for (const member of MEMBERS) {
  Object.defineProperty(exports, member, {
    get() {
      load();
      return exports[member];
    },
    enumerable: true,
    configurable: true
  });
}
