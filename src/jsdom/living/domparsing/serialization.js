"use strict";

// Only used to decode the serialization buffer into a string (latin1Slice/ucs2Slice), which has no web equivalent.
const { Buffer } = require("node:buffer");
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

// The node whose children are serialized as an element's children: a <template>'s are in its template contents.
function childContainer(element) {
  return element._namespaceURI === HTML_NS && element._prefix === null && element._localName === "template" ?
    element._templateContents :
    element;
}

function serializeChildNodes(parent, scriptingEnabled) {
  const container = parent.nodeType === NODE_TYPE.ELEMENT_NODE ? childContainer(parent) : parent;

  let html = "";
  for (let child = container._links?.firstChild ?? null; child !== null; child = child._links.nextSibling) {
    html += serializeNode(child, container, scriptingEnabled);
  }
  return html;
}

function serializeStartTag(node, tagName) {
  let html = "<" + tagName;

  const attributeList = node._attributeList;
  if (node._isValue && !attributeList.some(attr => attr._qualifiedName === "is")) {
    html += ` is="${escapeAttribute(node._isValue)}"`;
  }
  for (let i = 0; i < attributeList.length; ++i) {
    const attr = attributeList[i];
    html += " " + attr._qualifiedName + "=\"" + escapeAttribute(attr._value) + "\"";
  }
  return html + ">";
}

function serializeNode(node, parent, scriptingEnabled) {
  if (node.nodeType === NODE_TYPE.ELEMENT_NODE) {
    const tagName = node._qualifiedName;
    const html = serializeStartTag(node, tagName);
    if (node._namespaceURI === HTML_NS && VOID_ELEMENTS.has(tagName)) {
      return html;
    }
    return html + serializeChildNodes(node, scriptingEnabled) + "</" + tagName + ">";
  }
  return serializeNonElement(node, parent, scriptingEnabled);
}

function isRawTextParent(parent, scriptingEnabled) {
  if (parent !== null && parent.nodeType === NODE_TYPE.ELEMENT_NODE && parent._namespaceURI === HTML_NS) {
    const parentTagName = parent._qualifiedName;
    return UNESCAPED_TEXT.has(parentTagName) || (scriptingEnabled && parentTagName === "noscript");
  }
  return false;
}

function serializeNonElement(node, parent, scriptingEnabled) {
  switch (node.nodeType) {
    case NODE_TYPE.TEXT_NODE:
    case NODE_TYPE.CDATA_SECTION_NODE:
      return isRawTextParent(parent, scriptingEnabled) ? node._data : escapeText(node._data);
    case NODE_TYPE.COMMENT_NODE:
      return "<!--" + node._data + "-->";
    case NODE_TYPE.DOCUMENT_TYPE_NODE:
      return "<!DOCTYPE " + node.name + ">";
    default:
      return "";
  }
}

// The serializer proper writes char codes into a reusable typed array and decodes it into a string once, which beats
// building the output by string concatenation. It produces exactly what the string-based functions above produce
// (which remain for the rare cases this cannot handle). The buffer holds one byte per char code until a char code
// above 0xFF is written, then switches to two bytes per char code.

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const INITIAL_BUFFER_SIZE = 1 << 16;
const MAX_RETAINED_BUFFER_SIZE = 1 << 24;

let buf = new Uint8Array(INITIAL_BUFFER_SIZE);
let wide = false;
let pos = 0;
let writing = false;

// Thrown when the output needs two bytes per char code on a big-endian platform; the caller then uses the string-based
// serializer instead.
const NEEDS_FALLBACK = Symbol("needs fallback");

function reserve(extra) {
  const needed = pos + extra;
  if (needed > buf.length) {
    let size = buf.length * 2;
    while (size < needed) {
      size *= 2;
    }
    const newBuf = wide ? new Uint16Array(size) : new Uint8Array(size);
    newBuf.set(buf.subarray(0, pos));
    buf = newBuf;
  }
  return buf;
}

function widen() {
  if (!LITTLE_ENDIAN) {
    throw NEEDS_FALLBACK;
  }
  const newBuf = new Uint16Array(buf.length);
  newBuf.set(buf.subarray(0, pos));
  buf = newBuf;
  wide = true;
  return buf;
}

// The writers have separate loops for each buffer type, so that each loop only ever sees one kind of typed array.
function writeString(str) {
  if (wide) {
    writeStringWide(str, 0);
    return;
  }
  const { length } = str;
  if (pos + length > buf.length) {
    reserve(length);
  }
  const b = buf;
  let p = pos;
  for (let i = 0; i < length; ++i) {
    const c = str.charCodeAt(i);
    if (c > 0xFF) {
      pos = p;
      widen();
      writeStringWide(str, i);
      return;
    }
    b[p++] = c;
  }
  pos = p;
}

function writeStringWide(str, start) {
  const { length } = str;
  const b = reserve(length - start);
  let p = pos;
  for (let i = start; i < length; ++i) {
    b[p++] = str.charCodeAt(i);
  }
  pos = p;
}

// For each Latin-1 char code: bit 1 if escapeText escapes it, bit 2 if escapeAttribute does.
const ESCAPE_TEXT = 1;
const ESCAPE_ATTRIBUTE = 2;
const ESCAPES = new Uint8Array(256);
ESCAPES[38] = ESCAPE_TEXT | ESCAPE_ATTRIBUTE; // &
ESCAPES[160] = ESCAPE_TEXT | ESCAPE_ATTRIBUTE; // NBSP
ESCAPES[60] = ESCAPE_TEXT; // <
ESCAPES[62] = ESCAPE_TEXT; // >
ESCAPES[34] = ESCAPE_ATTRIBUTE; // "

function escapeReplacement(c) {
  switch (c) {
    case 38:
      return "&amp;";
    case 160:
      return "&nbsp;";
    case 34:
      return "&quot;";
    case 60:
      return "&lt;";
    default:
      return "&gt;";
  }
}

function writeEscaped(str, mask) {
  if (wide) {
    writeEscapedWide(str, 0, mask);
    return;
  }
  const { length } = str;
  if (pos + length > buf.length) {
    reserve(length);
  }
  let b = buf;
  let p = pos;
  for (let i = 0; i < length; ++i) {
    const c = str.charCodeAt(i);
    if (c > 0xFF) {
      pos = p;
      widen();
      writeEscapedWide(str, i, mask);
      return;
    }
    if ((ESCAPES[c] & mask) !== 0) {
      pos = p;
      writeString(escapeReplacement(c));
      b = reserve(length - i);
      p = pos;
    } else {
      b[p++] = c;
    }
  }
  pos = p;
}

function writeEscapedWide(str, start, mask) {
  const { length } = str;
  let b = reserve(length - start);
  let p = pos;
  for (let i = start; i < length; ++i) {
    const c = str.charCodeAt(i);
    if (c <= 0xFF && (ESCAPES[c] & mask) !== 0) {
      pos = p;
      writeStringWide(escapeReplacement(c), 0);
      b = reserve(length - i);
      p = pos;
    } else {
      b[p++] = c;
    }
  }
  pos = p;
}

function writeEndTag(tagName) {
  reserve(3);
  buf[pos++] = 60; // <
  buf[pos++] = 47; // /
  writeString(tagName);
  reserve(1);
  buf[pos++] = 62; // >
}

// Writes `start` and, unless `startOnly`, its following siblings, each with its descendants. `parent` is the node
// holding them (for a template, its template contents).
function writeNodes(start, parent, scriptingEnabled, startOnly) {
  // Explicit stack instead of recursion: trees can be arbitrarily deep. Holds, for each element whose children are
  // being written, the element, its tag name, and whether its parent's text children are written unescaped.
  const stack = [];
  let rawText = isRawTextParent(parent, scriptingEnabled);
  let node = start;
  for (;;) {
    const type = node.nodeType;
    if (type === NODE_TYPE.ELEMENT_NODE) {
      const prefix = node._prefix;
      const localName = node._localName;
      const isHTML = node._namespaceURI === HTML_NS;
      const tagName = prefix === null ? localName : prefix + ":" + localName;
      reserve(1);
      buf[pos++] = 60; // <
      writeString(tagName);

      const attributeList = node._attributeList;
      if (node._isValue && !attributeList.some(attr => attr._qualifiedName === "is")) {
        writeString(" is=\"");
        writeEscaped(node._isValue, ESCAPE_ATTRIBUTE);
        writeString("\"");
      }
      for (let i = 0; i < attributeList.length; ++i) {
        const attr = attributeList[i];
        reserve(1);
        buf[pos++] = 32; // space
        if (attr._namespacePrefix !== null) {
          writeString(attr._namespacePrefix);
          reserve(1);
          buf[pos++] = 58; // :
        }
        writeString(attr._localName);
        reserve(2);
        buf[pos++] = 61; // =
        buf[pos++] = 34; // "
        writeEscaped(attr._value, ESCAPE_ATTRIBUTE);
        reserve(1);
        buf[pos++] = 34; // "
      }
      reserve(1);
      buf[pos++] = 62; // >

      if (!isHTML || !VOID_ELEMENTS.has(tagName)) {
        const container = isHTML && localName === "template" && prefix === null ? node._templateContents : node;
        const links = container._links;
        const firstChild = links === null ? null : links.firstChild;
        if (firstChild !== null) {
          stack.push(node, tagName, rawText);
          rawText = isHTML && (UNESCAPED_TEXT.has(tagName) || (scriptingEnabled && tagName === "noscript"));
          node = firstChild;
          continue;
        }
        writeEndTag(tagName);
      }
    } else if (type === NODE_TYPE.TEXT_NODE || type === NODE_TYPE.CDATA_SECTION_NODE) {
      if (rawText) {
        writeString(node._data);
      } else {
        writeEscaped(node._data, ESCAPE_TEXT);
      }
    } else {
      // Only text serialization depends on the parent.
      writeString(serializeNonElement(node, null, scriptingEnabled));
    }

    // Move to the next node in tree order, closing the elements left.
    for (;;) {
      if (startOnly && stack.length === 0) {
        return;
      }
      const next = node._links.nextSibling;
      if (next !== null) {
        node = next;
        break;
      }
      if (stack.length === 0) {
        return;
      }
      rawText = stack.pop();
      const tagName = stack.pop();
      node = stack.pop();
      writeEndTag(tagName);
    }
  }
}

// Returns the serialization of `start` (and its following siblings unless `startOnly`), or undefined if the
// string-based serializer must be used instead.
function serializeToBuffer(start, parent, scriptingEnabled, startOnly) {
  if (writing) {
    return undefined;
  }
  writing = true;
  pos = 0;
  try {
    writeNodes(start, parent, scriptingEnabled, startOnly);
    const bytes = Buffer.from(buf.buffer, buf.byteOffset, pos * buf.BYTES_PER_ELEMENT);
    return wide ? bytes.ucs2Slice(0, bytes.length) : bytes.latin1Slice(0, bytes.length);
  } catch (e) {
    if (e === NEEDS_FALLBACK) {
      return undefined;
    }
    throw e;
  } finally {
    if (wide || buf.length > MAX_RETAINED_BUFFER_SIZE) {
      buf = new Uint8Array(INITIAL_BUFFER_SIZE);
      wide = false;
    }
    writing = false;
  }
}

function serializeChildNodesFast(parent, scriptingEnabled) {
  const container = parent.nodeType === NODE_TYPE.ELEMENT_NODE ? childContainer(parent) : parent;
  const links = container._links;
  const firstChild = links === null ? null : links.firstChild;
  if (firstChild === null) {
    return "";
  }
  return serializeToBuffer(firstChild, container, scriptingEnabled, false) ??
    serializeChildNodes(parent, scriptingEnabled);
}

function serializeNodeFast(node, parent, scriptingEnabled) {
  if (node.nodeType !== NODE_TYPE.ELEMENT_NODE) {
    return serializeNonElement(node, parent, scriptingEnabled);
  }
  return serializeToBuffer(node, parent, scriptingEnabled, true) ?? serializeNode(node, parent, scriptingEnabled);
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
      return serializeNodeFast(node, node._links?.parent ?? null, scriptingEnabled);
    }
    return isHTMLVoidElement(node) ? "" : serializeChildNodesFast(node, scriptingEnabled);
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
