"use strict";
const native = require("../../../native");
const csstree = require("./patched-csstree.js");

// Parses CSS with the Rust port of css-tree's parser (src/native/src/css_parser.rs), producing the same tree that
// css-tree produces with the options jsdom uses, except that lists are arrays, nodes have no `loc`, and Value nodes
// (custom property values) only carry their serialization, as `generated`. Raw nodes containing a backslash also
// carry theirs, as css-tree's generator inserts a newline after a backslash delimiter. See generateNode() in
// css-parser.js.
//
// The native parser recovers from parse errors as css-tree does, and reports them as css-tree's onParseError would.
// parse() returns null for inputs using constructs the port leaves to css-tree, which callers then parse with css-tree.

// Modes of the native parser, mirroring the css-tree parse options in css-parser.js and CSSStyleDeclaration-impl.js.
exports.STYLESHEET = 0; // context: "stylesheet", parseCustomProperty: true
exports.DECLARATION_LIST = 1; // context: "declarationList", parseCustomProperty: true
exports.DECLARATION_LIST_RAW_CUSTOM_PROPERTIES = 2; // context: "declarationList", parseCustomProperty: false

// An older prebuilt addon may not have the CSS parser.
const parseCss = native?.parseCss;

const OP_RULE = 1;
const OP_ATRULE = 2;
const OP_DECLARATION = 3;
const OP_RAW = 4;
const OP_COMMENT = 5;
const OP_CDO = 6;
const OP_CDC = 7;
const NONE = 0xFFFFFFFF;

// The messages of the parse errors, by their index in the native parser's error records (MSG_* in css_parser.rs).
const MESSAGES = [
  "Unexpected input",
  "Identifier is expected",
  "Identifier is expected but function found",
  "Colon is expected",
  "\"{\" is expected",
  "\")\" is expected",
  "\"]\" is expected",
  "String is expected",
  "Hex or identifier is expected"
];

// Parses `source`; returns the tree, or null. With `onParseError`, calls it with each parse error, as css-tree's
// parse() option of that name does, after building the tree.
exports.parse = (source, mode, onParseError) => {
  if (parseCss === undefined) {
    return null;
  }
  const result = parseCss(source, mode);
  if (result === null) {
    return null;
  }
  const { ops, strings } = result;
  let i = 1;

  // Reads a Raw node's start, end, gen, genEnd at ops[i].
  function readRaw() {
    const node = { type: "Raw", value: source.slice(ops[i], ops[i + 1]) };
    if (ops[i + 2] !== NONE) {
      node.generated = strings.slice(ops[i + 2], ops[i + 3]);
    }
    i += 4;
    return node;
  }

  function readChildren(count) {
    const children = new Array(count);
    for (let n = 0; n < count; n++) {
      children[n] = readNode();
    }
    return children;
  }

  function readNode() {
    switch (ops[i++]) {
      case OP_RULE: {
        const prelude = readRaw();
        const children = readChildren(ops[i++]);
        return { type: "Rule", prelude, block: { type: "Block", children } };
      }
      case OP_ATRULE: {
        const name = source.slice(ops[i], ops[i + 1]);
        i += 2;
        let prelude = null;
        if (ops[i] === NONE) {
          i += 4;
        } else {
          prelude = readRaw();
        }
        const count = ops[i++];
        const block = count === NONE ? null : { type: "Block", children: readChildren(count) };
        return { type: "Atrule", name, prelude, block };
      }
      case OP_DECLARATION: {
        const property = source.slice(ops[i], ops[i + 1]);
        const importantKind = ops[i + 2];
        const important = importantKind === 2 ? source.slice(ops[i + 3], ops[i + 4]) : importantKind === 1;
        const isValue = ops[i + 5] === 1;
        i += 6;
        let value;
        if (isValue) {
          value = { type: "Value", generated: strings.slice(ops[i + 2], ops[i + 3]) };
          i += 4;
        } else {
          value = readRaw();
        }
        return { type: "Declaration", important, property, value };
      }
      case OP_RAW:
        return readRaw();
      case OP_COMMENT:
        return { type: "Comment" };
      case OP_CDO:
        return { type: "CDO" };
      case OP_CDC:
        return { type: "CDC" };
      default:
        throw new Error(`Internal error: unknown native CSS parser instruction ${ops[i - 1]}`);
    }
  }

  const ast = {
    type: mode === exports.STYLESHEET ? "StyleSheet" : "DeclarationList",
    children: readChildren(ops[0])
  };

  if (onParseError !== undefined) {
    const { errors } = result;
    // css-tree's SyntaxError() is a factory, not a constructor.
    const { SyntaxError: createSyntaxError } = csstree.parse;
    for (let e = 0; e < errors.length; e += 4) {
      onParseError(createSyntaxError(MESSAGES[errors[e]], source, errors[e + 1], errors[e + 2], errors[e + 3]));
    }
  }

  return ast;
};
