"use strict";
// Native (Rust) XML parsing. The addon parses the whole input in one call and returns a flat instruction stream (see
// src/native/src/xml_parser.rs) that is replayed here, performing the operations that the saxes event handlers in
// ./xml.js perform, in the same order. The addon declines (returns null) any input on which saxes would report a
// well-formedness error, and some valid inputs it does not handle; the caller parses those with saxes, which reports
// the error (after the same side effects, since nothing has been done with the input yet).

const native = require("../../native");

const {
  createElement, getHTMLElementInterface, getSVGInterface
} = require("../../living/helpers/create-element");
const { HTML_NS, SVG_NS } = require("../../living/helpers/namespaces");
const { implForWrapper } = require("../../../generated/idl/utils");
const interfaces = require("../../living/interfaces");

const DocumentFragment = require("../../../generated/idl/DocumentFragment");
const CDATASection = require("../../../generated/idl/CDATASection");
const Comment = require("../../../generated/idl/Comment");
const ProcessingInstruction = require("../../../generated/idl/ProcessingInstruction");
// Text and Attr wrappers are created lazily; see Text-impl.js and Attr-impl.js.
const TextImpl = require("../../living/nodes/Text-impl").implementation;
const AttrImpl = require("../../living/attributes/Attr-impl").implementation;

const attributes = require("../../living/attributes");
const treeHelpers = require("../../living/helpers/dom-tree");
const { finishDetachedTree } = require("./html-native");

const OP_TEXT = 1;
const OP_CDATA = 2;
const OP_COMMENT = 3;
const OP_PI = 4;
const OP_DOCTYPE = 5;
const OP_OPEN = 6;
const OP_CLOSE = 7;

// The most attributes appendNewAttributes() appends to one element; elements with more go through the generic path,
// which maintains the by-name index of elements with many attributes (see living/attributes.js).
const MAX_NEW_ATTRIBUTES = 8;

function hasCustomElementDefinitions(documentImpl) {
  if (!documentImpl._defaultView) {
    // lookupCEDefinition() finds nothing for documents without a browsing context.
    return false;
  }
  const registry = implForWrapper(documentImpl._globalObject._customElementRegistry);
  return Boolean(registry) && registry._customElementDefinitions.length > 0;
}

function hasObservers(node) {
  const observers = node._registeredObserverList;
  return observers !== null && observers.length > 0;
}

// Element names whose insertion into a document with scripting enabled can run script (a parser-inserted script runs
// when popped; nested browsing contexts load when connected), and `checked`, whose insertion effects depend on the
// order of insertion (see html-native.js canReplayFast()).
const ORDER_SENSITIVE_NAMES = new Set(["script", "iframe", "frame", "object", "embed"]);

// The instruction stream is written to a reusable buffer when it fits, which is much cheaper than creating a typed
// array per parse for small inputs. A parse that runs script (in the slow replay) can parse XML again, so the buffer
// is taken while a parse uses it. The addon picks the length (0 in the WebAssembly build, which cannot write to it).
const BUFFER_LENGTH = native.xmlOpsBufferLength();
let spareBuffer = new Uint32Array(BUFFER_LENGTH);

// Returns { ops, extra, buffer }, or null if the native parser declined the input. The caller passes `buffer` to
// releaseBuffer() when done with `ops`.
function parseNative(markup, resolvePrefix) {
  const buffer = spareBuffer ?? new Uint32Array(BUFFER_LENGTH);
  spareBuffer = null;
  const extra = native.parseXml(markup, resolvePrefix, buffer);
  if (extra === null) {
    spareBuffer = buffer;
    return null;
  }
  return { ops: buffer.length === 0 || buffer[0] === 0 ? native.takeXmlOps() : buffer, extra, buffer };
}

function releaseBuffer(buffer) {
  spareBuffer = buffer;
}

function decodeNames(ops, markup, extra) {
  const inputLength = markup.length;
  const table = ops[0];
  const nameCount = ops[table];
  const names = new Array(nameCount);
  names[0] = null;
  for (let n = 1; n < nameCount; n++) {
    const off = ops[table + 1 + n * 2];
    const end = off + ops[table + 2 + n * 2];
    names[n] = off < inputLength ? markup.slice(off, end) : extra.slice(off - inputLength, end - inputLength);
  }
  return names;
}

// Replays the instruction stream into `root` (a Document or DocumentFragment). With `fast`, nodes are linked directly
// (`root` must be detached and unobservable: a fresh fragment, or a temporary container whose children are later
// inserted into the document), and the caller applies the remaining effects of the insert algorithm afterwards with
// finishDetachedTree(). Without it, every node is inserted with the generic insert algorithm, as xml.js does.
// HTML <script> elements popped while `poppedScripts` is given are collected there instead of being prepared.
function replay(ops, names, markup, extra, root, fast, parseDocType, poppedScripts) {
  const inputLength = markup.length;
  const globalObject = root._globalObject;
  const nameCount = names.length;

  function str(off, len) {
    return off < inputLength ?
      markup.slice(off, off + len) :
      extra.slice(off - inputLength, off - inputLength + len);
  }

  // Per (namespace, local name) pair: the interface of elements that cannot be custom elements, as createElement()
  // would pick it; false for names that could be custom.
  const interfaceCache = new Map();
  function createElementFast(doc, localId, nsId, prefixId, isValue) {
    const localName = names[localId];
    const namespace = names[nsId];
    if (isValue !== null && namespace === HTML_NS) {
      return null;
    }
    const key = nsId * nameCount + localId;
    let elementInterface = interfaceCache.get(key);
    if (elementInterface === undefined) {
      if (namespace === HTML_NS) {
        elementInterface = localName.includes("-") ? false : getHTMLElementInterface(localName);
      } else if (namespace === SVG_NS) {
        elementInterface = getSVGInterface(localName);
      } else {
        elementInterface = interfaces.getInterfaceWrapper("Element");
      }
      interfaceCache.set(key, elementInterface);
    }
    if (elementInterface === false) {
      return null;
    }
    return elementInterface.createImpl(globalObject, [], {
      ownerDocument: doc,
      localName,
      namespace,
      prefix: names[prefixId],
      ceState: "uncustomized",
      ceDefinition: null,
      isValue
    });
  }

  // Appends the attributes of a newly created, uncustomized element without a parent; the Rust side has rejected
  // inputs with duplicate attributes. Equivalent to setAttributeValue() for each, but skipping the steps that cannot
  // have an effect then: looking for an existing attribute, mutation records (no observer can be registered on the
  // element or an ancestor yet), and custom element reactions. Few enough attributes are appended that the element
  // does not index them by name yet.
  function appendNewAttributes(element, i, count) {
    const ownerDoc = element._ownerDocument;
    // Attribute change steps can read the attribute list, so it must hold exactly the attributes appended so far.
    const list = element._attributeList;
    for (let a = 0; a < count; a++, i += 5) {
      const localName = names[ops[i]];
      const namespace = names[ops[i + 1]];
      const value = str(ops[i + 3], ops[i + 4]);
      list.push(new AttrImpl(globalObject, [], {
        namespace,
        namespacePrefix: names[ops[i + 2]],
        localName,
        value,
        element,
        ownerDocument: ownerDoc
      }));
      element._attributeChangeSteps(localName, null, value, namespace);
    }
    return i;
  }

  function setAttributes(element, i, count) {
    for (let a = 0; a < count; a++, i += 5) {
      const value = str(ops[i + 3], ops[i + 4]);
      attributes.setAttributeValue(element, names[ops[i]], value, names[ops[i + 2]], names[ops[i + 1]]);
    }
    return i;
  }

  const insert = fast ?
    (parent, child) => treeHelpers.appendChild(parent, child) :
    (parent, child) => parent._insert(child, null);

  // As in xml.js, where children go and their node document are looked up for each node: in the slow mode, script run
  // while parsing (e.g. a popped <script>) could have moved the current element to another document.
  const openStack = [root];
  let parent = root;
  function setParent() {
    const element = openStack[openStack.length - 1];
    parent = element._localName === "template" && element._namespaceURI === HTML_NS ?
      element._templateContents :
      element;
  }

  let i = 1;
  const end = ops[0];
  while (i < end) {
    switch (ops[i]) {
      case OP_TEXT:
        insert(parent, new TextImpl(globalObject, [], {
          data: str(ops[i + 1], ops[i + 2]),
          ownerDocument: parent._ownerDocument
        }));
        i += 3;
        break;
      case OP_CDATA:
        insert(parent, CDATASection.createImpl(globalObject, [], {
          data: str(ops[i + 1], ops[i + 2]),
          ownerDocument: parent._ownerDocument
        }));
        i += 3;
        break;
      case OP_COMMENT:
        insert(parent, Comment.createImpl(globalObject, [], {
          data: str(ops[i + 1], ops[i + 2]),
          ownerDocument: parent._ownerDocument
        }));
        i += 3;
        break;
      case OP_PI:
        insert(parent, ProcessingInstruction.createImpl(globalObject, [], {
          target: str(ops[i + 1], ops[i + 2]),
          data: str(ops[i + 3], ops[i + 4]),
          ownerDocument: parent._ownerDocument
        }));
        i += 5;
        break;
      case OP_DOCTYPE:
        insert(parent, parseDocType(globalObject, parent._ownerDocument, `<!doctype ${str(ops[i + 1], ops[i + 2])}>`));
        i += 3;
        break;
      case OP_OPEN: {
        const localId = ops[i + 1];
        const nsId = ops[i + 2];
        const prefixId = ops[i + 3];
        const attrCount = ops[i + 4];
        i += 5;

        // saxes keys attributes by qualified name, so only an unprefixed "is" attribute counts.
        let isValue = null;
        for (let a = 0, j = i; a < attrCount; a++, j += 5) {
          if (ops[j + 2] === 0 && names[ops[j]] === "is") {
            isValue = str(ops[j + 3], ops[j + 4]);
            break;
          }
        }

        const doc = parent._ownerDocument;
        let element = createElementFast(doc, localId, nsId, prefixId, isValue);
        if (element !== null && attrCount <= MAX_NEW_ATTRIBUTES) {
          i = attrCount === 0 ? i : appendNewAttributes(element, i, attrCount);
        } else {
          if (element === null) {
            element = createElement(doc, names[localId], names[nsId], names[prefixId], isValue, true);
          }
          i = setAttributes(element, i, attrCount);
        }

        // We mark a script element as "parser-inserted", which prevents it from being immediately executed.
        if (element._localName === "script" && element._namespaceURI === HTML_NS) {
          element._parserInserted = true;
        }

        insert(parent, element);
        openStack.push(element);
        setParent();
        break;
      }
      case OP_CLOSE: {
        const element = openStack.pop();
        // Prepare scripts after their contents have been parsed.
        if (element._localName === "script" && element._namespaceURI === HTML_NS) {
          if (poppedScripts !== undefined) {
            poppedScripts.push(element);
          } else {
            element._poppedOffStackOfOpenElements();
          }
        }
        setParent();
        i += 1;
        break;
      }
      default:
        throw new Error(`Internal error: unknown native XML parser instruction ${ops[i]}`);
    }
  }
}

// Returns false if the native parser declined the input; the caller then parses it with saxes.
function parseIntoDocument(markup, documentImpl, parseDocType) {
  const result = parseNative(markup, undefined);
  if (result === null) {
    return false;
  }
  const { ops, extra, buffer } = result;
  const names = decodeNames(ops, markup, extra);

  // With scripting, a popped script or a nested browsing context runs script in the middle of the parse, which must
  // see the partially parsed document; custom element constructors run when elements are created. Mutation observers
  // on the document would see one record per top-level node instead of one per parser insertion. In those cases,
  // insert each node into the document as it is parsed, exactly as xml.js does.
  const window = documentImpl._defaultView;
  let slow = hasObservers(documentImpl) || hasCustomElementDefinitions(documentImpl) || names.includes("checked");
  if (!slow && window && window._settings.runScripts === "dangerously") {
    slow = names.some(name => ORDER_SENSITIVE_NAMES.has(name));
  }
  if (slow) {
    replay(ops, names, markup, extra, documentImpl, false, parseDocType);
    releaseBuffer(buffer);
    return true;
  }

  // Build the tree detached, in a temporary container, then insert each top-level node into the document with the
  // generic insert algorithm, which runs the connected insertion steps, document caches, and post-connection steps for
  // the whole subtree. Scripts popped while detached are prepared once connected, in parser order.
  const container = DocumentFragment.createImpl(documentImpl._globalObject, [], { ownerDocument: documentImpl });
  const poppedScripts = [];
  replay(ops, names, markup, extra, container, true, parseDocType, poppedScripts);
  releaseBuffer(buffer);
  finishDetachedTree(container, false);
  if (window && !names.includes("base")) {
    // Connecting a <style> or <link> computes (and caches) the document base URL by searching the document for
    // <base href>; see html-native.js parseIntoDocument().
    documentImpl.baseURL();
  }
  for (let child = container.firstChild; child !== null; child = container.firstChild) {
    treeHelpers.remove(child);
    documentImpl._insert(child, null);
  }
  for (const script of poppedScripts) {
    script._poppedOffStackOfOpenElements();
  }
  return true;
}

// Parses into the new, empty `fragment`. Returns false if the native parser declined the input.
function parseFragment(markup, fragment, resolvePrefix, parseDocType) {
  // Custom element constructors run while the fragment is built could change what resolvePrefix() returns, which the
  // native parser calls before any element is created.
  if (hasCustomElementDefinitions(fragment._ownerDocument)) {
    return false;
  }
  const result = parseNative(markup, resolvePrefix);
  if (result === null) {
    return false;
  }
  const { ops, extra, buffer } = result;
  const names = decodeNames(ops, markup, extra);
  if (names.includes("checked")) {
    replay(ops, names, markup, extra, fragment, false, parseDocType);
  } else {
    // The fragment is new, so nothing can observe it while it is being built.
    replay(ops, names, markup, extra, fragment, true, parseDocType);
    finishDetachedTree(fragment, true);
  }
  releaseBuffer(buffer);
  return true;
}

module.exports = {
  parseFragment,
  parseIntoDocument
};
