"use strict";

const nativeParser = require("./html-native");

const { HTML_NS } = require("../../living/helpers/namespaces");

// HTML is parsed by rsdom's Rust core (html5ever; see ./html-native.js). There is no JavaScript HTML parser:
// parse5 remains only a development dependency, as the reference that tests/differential/ compares the results with.

function parseFragment(markup, contextElement) {
  const ownerDocument = contextElement.localName === "template" && contextElement.namespaceURI === HTML_NS ?
    contextElement.content._ownerDocument :
    contextElement._ownerDocument;

  return nativeParser.parseFragment(markup, contextElement, ownerDocument);
}

function parseIntoDocument(markup, ownerDocument) {
  nativeParser.parseIntoDocument(markup, ownerDocument);
  return ownerDocument;
}

// Decodes `bytes` as `encoding` and parses the result into the document. Returns false if the decoded text is empty.
function parseBytesIntoDocument(bytes, encoding, ownerDocument) {
  const markup = nativeParser.parseBytesIntoDocument(bytes, encoding, ownerDocument);
  if (markup === null) {
    return true;
  }
  parseIntoDocument(markup, ownerDocument);
  return markup !== "";
}

module.exports = {
  parseFragment,
  parseIntoDocument,
  parseBytesIntoDocument
};
