"use strict";

// css-tree, forked with the csstools syntax patches. Loading and forking it takes tens of milliseconds, which every
// process (e.g. every Vitest test file) would pay up front even if it never parses CSS, so it is done on first use:
// this module's members start out as getters that load the fork, then replace themselves with its members.

// The members of the forked API (csstree.fork()), plus the standalone utilities re-exported below.
const MEMBERS = [
  "lexer", "createLexer", "tokenize", "parse", "generate", "walk", "find", "findLast", "findAll", "fromPlainObject",
  "toPlainObject", "fork", "string", "ident", "definitionSyntax"
];

// css-tree's TokenStream keeps its token buffers across parses and only grows them, and setSource() zero-fills the
// whole `balance` buffer on every parse. So after one large stylesheet, every later parse, even of a one-declaration
// style attribute, costs time proportional to that stylesheet's length (about 50µs per parse after a 1.7MB sheet).
// Give setSource() a view of the buffer no longer than the one css-tree would allocate for the new source, which keeps
// the work proportional to the source being parsed. (adoptBuffer() in css-tree/lib/tokenizer/adopt-buffer.js.)
const MIN_BUFFER_SIZE = 16 * 1024;

function boundTokenStreamBuffers(TokenStream) {
  const { setSource } = TokenStream.prototype;
  TokenStream.prototype.setSource = function (source, tokenize) {
    const { balance } = this;
    if (balance) {
      const size = Math.max(String(source || "").length + 1 + 1024, MIN_BUFFER_SIZE);
      if (balance.length !== size && balance.buffer.byteLength >= size * Uint32Array.BYTES_PER_ELEMENT) {
        this.balance = new Uint32Array(balance.buffer, 0, size);
      }
    }
    return setSource.call(this, source, tokenize);
  };
}

function load() {
  const { next: syntaxes } = require("@csstools/css-syntax-patches-for-csstree");
  const csstree = require("css-tree");
  boundTokenStreamBuffers(require("css-tree/tokenizer").TokenStream);

  // fork() only returns the core parse/generate/walk API, dropping standalone utilities like string, url,
  // ident, tokenTypes, etc. Re-export the ones we need.
  const forked = csstree.fork(syntaxes);
  forked.string = csstree.string;
  forked.ident = csstree.ident;
  forked.definitionSyntax = csstree.definitionSyntax;

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
