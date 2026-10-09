"use strict";

const produceXMLSerialization = require("w3c-xmlserializer");
const DOMException = require("../../../generated/idl/DOMException");
const utils = require("../../../generated/idl/utils");
const NODE_TYPE = require("../node-type");
const { HTML_NS } = require("../helpers/namespaces");

// A direct port of parse5's serializer (parse5/dist/serializer/index.js) together with the jsdom tree adapter that
// used to feed it (./parse5-adapter-serialization.js). It walks the impl tree's links instead of going through the
// adapter, which allocated an array per element for its children and its attributes. Its output must stay
// byte-for-byte identical to parse5's.

const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
  "param", "source", "track", "wbr"
]);

const UNESCAPED_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

// The escapes of entities/escape's escapeText ([&<>\u00A0]) and escapeAttribute (["&\u00A0]), used by parse5. Most
// strings need no escaping, and a char code scan finds that out faster than a regular expression for typical lengths.
function escapeText(str) {
  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 160) {
      return escapeFrom(str, i, false);
    }
  }
  return str;
}

function escapeAttribute(str) {
  for (let i = 0; i < str.length; ++i) {
    const c = str.charCodeAt(i);
    if (c === 34 || c === 38 || c === 160) {
      return escapeFrom(str, i, true);
    }
  }
  return str;
}

function escapeFrom(str, start, isAttribute) {
  let out = str.slice(0, start);
  let last = start;
  for (let i = start; i < str.length; ++i) {
    let replacement;
    switch (str.charCodeAt(i)) {
      case 38:
        replacement = "&amp;";
        break;
      case 160:
        replacement = "&nbsp;";
        break;
      case 34:
        if (!isAttribute) {
          continue;
        }
        replacement = "&quot;";
        break;
      case 60:
        if (isAttribute) {
          continue;
        }
        replacement = "&lt;";
        break;
      case 62:
        if (isAttribute) {
          continue;
        }
        replacement = "&gt;";
        break;
      default:
        continue;
    }
    out += str.slice(last, i) + replacement;
    last = i + 1;
  }
  return out + str.slice(last);
}

function isHTMLVoidElement(node) {
  return node.nodeType === NODE_TYPE.ELEMENT_NODE && node._namespaceURI === HTML_NS &&
    VOID_ELEMENTS.has(node._qualifiedName);
}

function serializeChildNodes(parent, scriptingEnabled) {
  const container = parent.nodeType === NODE_TYPE.ELEMENT_NODE && parent._namespaceURI === HTML_NS &&
    parent._qualifiedName === "template" ?
    parent._templateContents :
    parent;

  let html = "";
  for (let child = container._links?.firstChild ?? null; child !== null; child = child._links.nextSibling) {
    html += serializeNode(child, container, scriptingEnabled);
  }
  return html;
}

function serializeNode(node, parent, scriptingEnabled) {
  switch (node.nodeType) {
    case NODE_TYPE.ELEMENT_NODE: {
      const tagName = node._qualifiedName;
      let html = "<" + tagName;

      const attributeList = node._attributeList;
      if (node._isValue && !attributeList.some(attr => attr._qualifiedName === "is")) {
        html += ` is="${escapeAttribute(node._isValue)}"`;
      }
      for (let i = 0; i < attributeList.length; ++i) {
        const attr = attributeList[i];
        html += " " + attr._qualifiedName + "=\"" + escapeAttribute(attr._value) + "\"";
      }
      html += ">";

      if (node._namespaceURI === HTML_NS && VOID_ELEMENTS.has(tagName)) {
        return html;
      }
      return html + serializeChildNodes(node, scriptingEnabled) + "</" + tagName + ">";
    }
    case NODE_TYPE.TEXT_NODE:
    case NODE_TYPE.CDATA_SECTION_NODE: {
      const content = node._data;
      if (parent !== null && parent.nodeType === NODE_TYPE.ELEMENT_NODE && parent._namespaceURI === HTML_NS) {
        const parentTagName = parent._qualifiedName;
        if (UNESCAPED_TEXT.has(parentTagName) || (scriptingEnabled && parentTagName === "noscript")) {
          return content;
        }
      }
      return escapeText(content);
    }
    case NODE_TYPE.COMMENT_NODE:
      return "<!--" + node._data + "-->";
    case NODE_TYPE.DOCUMENT_TYPE_NODE:
      return "<!DOCTYPE " + node.name + ">";
    default:
      return "";
  }
}

module.exports.fragmentSerialization = (node, { outer, requireWellFormed, globalObject }) => {
  const contextDocument =
    node.nodeType === NODE_TYPE.DOCUMENT_NODE ? node : node._ownerDocument;
  if (contextDocument._parsingMode === "html") {
    // parse5 merges the parse options over its default of `scriptingEnabled: true`, so an own property set to
    // undefined counts as false there.
    const parseOptions = contextDocument._parseOptions;
    const scriptingEnabled = parseOptions && Object.hasOwn(parseOptions, "scriptingEnabled") ?
      parseOptions.scriptingEnabled :
      true;
    if (outer) {
      return serializeNode(node, node._links?.parent ?? null, scriptingEnabled);
    }
    return isHTMLVoidElement(node) ? "" : serializeChildNodes(node, scriptingEnabled);
  }

  const childNodes = outer ? [node] : node._childrenToArray();

  try {
    let serialized = "";
    for (let i = 0; i < childNodes.length; ++i) {
      serialized += produceXMLSerialization(
        utils.wrapperForImpl(childNodes[i]),
        { requireWellFormed }
      );
    }
    return serialized;
  } catch (e) {
    throw DOMException.create(globalObject, [e.message, "InvalidStateError"]);
  }
};
