"use strict";
const fs = require("node:fs");
const { createRequire } = require("node:module");

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

// css-tree and the patches, from src/generated/css-tree-bundle.js (see scripts/generate-css-tree-bundle.js) if it is
// there and was built from the installed versions of the packages it contains, otherwise null.
function loadBundle() {
  let bundle;
  try {
    bundle = require("../../../../generated/css-tree-bundle.js");
  } catch {
    return null;
  }
  // The package.json path of each bundled package, resolved as its requirer would.
  const packageJSONPaths = new Map();
  for (const [name, version, requiredFrom] of bundle.packages) {
    const requireFrom = requiredFrom === null ? require : createRequire(packageJSONPaths.get(requiredFrom));
    let packageJSONPath, installed;
    try {
      packageJSONPath = requireFrom.resolve(`${name}/package.json`);
      ({ version: installed } = JSON.parse(fs.readFileSync(packageJSONPath, "utf-8")));
    } catch {
      return null;
    }
    if (installed !== version) {
      return null;
    }
    packageJSONPaths.set(name, packageJSONPath);
  }
  return bundle.load(require);
}

// Creates the patched syntax, from the bundle's modules if given (loadBundle()), otherwise from the packages.
function createPatchedSyntax(bundled) {
  if (bundled !== null) {
    boundTokenStreamBuffers(bundled.tokenizer.TokenStream);
    // What forking css-tree's default syntax does (see fork() in css-tree/cjs/syntax/create.cjs), without creating the
    // default syntax first.
    const defaultConfig = { ...bundled.lexerConfig, ...bundled.parserConfig, ...bundled.walkerConfig };
    const forked = bundled.createSyntax(bundled.mix(bundled.mix({}, defaultConfig), bundled.patches.next));
    forked.string = bundled.string;
    forked.ident = bundled.ident;
    forked.definitionSyntax = bundled.definitionSyntax;
    return forked;
  }

  const { next: syntaxes } = require("@csstools/css-syntax-patches-for-csstree");
  const csstree = require("css-tree");
  boundTokenStreamBuffers(require("css-tree/tokenizer").TokenStream);

  // fork() only returns the core parse/generate/walk API, dropping standalone utilities like string, url,
  // ident, tokenTypes, etc. Re-export the ones we need.
  const forked = csstree.fork(syntaxes);
  forked.string = csstree.string;
  forked.ident = csstree.ident;
  forked.definitionSyntax = csstree.definitionSyntax;
  return forked;
}

function load() {
  const forked = createPatchedSyntax(loadBundle());

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

// For tests.
exports._loadBundle = loadBundle;
exports._createPatchedSyntax = createPatchedSyntax;
