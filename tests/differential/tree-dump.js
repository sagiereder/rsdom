"use strict";
// Canonical, line-per-node dumps of a parsed tree, from either a parse5 tree (parse5's default tree adapter) or a jsdom
// DOM, so that the two can be compared line by line.

// Like JSON.stringify, but with object keys sorted (parse5 and jsdom build location objects in different orders) and
// with undefined spelled out, since a missing location (undefined) and an absent one (null) are different results.
function stable(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function attributeLine(namespace, prefix, localName, value) {
  return `@${namespace ?? ""} ${prefix || ""}:${localName}=${JSON.stringify(value)}`;
}

// parse5 tree (default tree adapter)

function dumpParse5(node, { locations }, lines = [], depth = 0) {
  const indent = "  ".repeat(depth);
  const location = locations ? ` ${stable(node.sourceCodeLocation)}` : "";
  switch (node.nodeName) {
    case "#document":
      lines.push(`#document ${node.mode}`);
      break;
    case "#document-fragment":
      lines.push(`${indent}#document-fragment${location}`);
      break;
    case "#documentType":
      lines.push(`${indent}<!DOCTYPE ${JSON.stringify(node.name)} ${JSON.stringify(node.publicId)} ` +
        `${JSON.stringify(node.systemId)}>${location}`);
      return lines;
    case "#comment":
      lines.push(`${indent}<!--${JSON.stringify(node.data)}-->${location}`);
      return lines;
    case "#text":
      lines.push(`${indent}${JSON.stringify(node.value)}${location}`);
      return lines;
    default:
      lines.push(`${indent}<${node.namespaceURI} ${node.tagName}>${location}`);
      for (const attr of node.attrs) {
        lines.push(`${indent}  ${attributeLine(attr.namespace, attr.prefix, attr.name, attr.value)}`);
      }
      if (node.content) {
        dumpParse5(node.content, { locations }, lines, depth + 1);
      }
  }
  for (const child of node.childNodes) {
    dumpParse5(child, { locations }, lines, depth + 1);
  }
  return lines;
}

// jsdom DOM. `locationOf` returns a node's sourceCodeLocation (JSDOM's nodeLocation()), or is null to omit locations.

function dumpDOM(node, { locationOf }, lines = [], depth = 0) {
  const indent = "  ".repeat(depth);
  const location = locationOf ? ` ${stable(locationOf(node))}` : "";
  switch (node.nodeType) {
    case node.DOCUMENT_NODE:
      lines.push(`#document ${documentMode(node)}`);
      break;
    case node.DOCUMENT_FRAGMENT_NODE:
      lines.push(`${indent}#document-fragment${location}`);
      break;
    case node.DOCUMENT_TYPE_NODE:
      lines.push(`${indent}<!DOCTYPE ${JSON.stringify(node.name)} ${JSON.stringify(node.publicId)} ` +
        `${JSON.stringify(node.systemId)}>${location}`);
      return lines;
    case node.COMMENT_NODE:
      lines.push(`${indent}<!--${JSON.stringify(node.data)}-->${location}`);
      return lines;
    case node.TEXT_NODE:
      lines.push(`${indent}${JSON.stringify(node.data)}${location}`);
      return lines;
    default:
      lines.push(`${indent}<${node.namespaceURI} ${node.localName}>${location}`);
      for (const attr of node.attributes) {
        lines.push(`${indent}  ${attributeLine(attr.namespaceURI, attr.prefix, attr.localName, attr.value)}`);
      }
      if (node.localName === "template" && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
        dumpDOM(node.content, { locationOf }, lines, depth + 1);
      }
  }
  for (const child of node.childNodes) {
    dumpDOM(child, { locationOf }, lines, depth + 1);
  }
  return lines;
}

// The document's mode is not exposed directly; compatMode tells quirks from the rest, and the quirks-mode-only CSS
// behaviour is what tells limited-quirks from no-quirks, so read jsdom's internal slot instead.
let implForWrapper;
function documentMode(document) {
  implForWrapper ??= require("../../src/generated/idl/utils.js").implForWrapper;
  return implForWrapper(document)._mode;
}

// Returns a description of the first difference between two dumps, with some context, or null if they are equal.
function firstDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      const from = Math.max(0, i - 3);
      return [
        `first difference at line ${i + 1}:`,
        `  parse5: ${expected[i] ?? "<end>"}`,
        `  rsdom:  ${actual[i] ?? "<end>"}`,
        "context (parse5):",
        ...expected.slice(from, i + 3).map(line => `    ${line}`),
        "context (rsdom):",
        ...actual.slice(from, i + 3).map(line => `    ${line}`)
      ].join("\n");
    }
  }
  return null;
}

module.exports = { dumpParse5, dumpDOM, firstDifference };
