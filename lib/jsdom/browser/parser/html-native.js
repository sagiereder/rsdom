"use strict";
// Native (Rust/html5ever) HTML parsing. The addon parses the whole input in one call and returns a flat instruction
// stream (see native/src/html_parser.rs) that is replayed here, performing exactly the operations that jsdom's parse5
// tree adapter (./html.js) performs, in the same order.

const native = require("../../native");

const { createElement } = require("../../living/helpers/create-element");
const { HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS } = require("../../living/helpers/namespaces");

const DocumentType = require("../../../generated/idl/DocumentType");
const DocumentFragment = require("../../../generated/idl/DocumentFragment");
const Text = require("../../../generated/idl/Text");
const Comment = require("../../../generated/idl/Comment");

const attributes = require("../../living/attributes");
const nodeTypes = require("../../living/node-type");
const { implForWrapper } = require("../../../generated/idl/utils");
const {
  customElementReactionsStack, invokeCEReactions, lookupCEDefinition
} = require("../../living/helpers/custom-elements");

const OP_ELEMENT = 1;
const OP_COMMENT = 2;
const OP_APPEND = 3;
const OP_APPEND_TEXT = 4;
const OP_INSERT_BEFORE = 5;
const OP_INSERT_TEXT_BEFORE = 6;
const OP_DETACH = 7;
const OP_REPARENT = 8;
const OP_PUSH = 9;
const OP_POP = 10;
const OP_DOCTYPE = 11;
const OP_MODE = 12;
const OP_ADD_ATTRS = 13;

const NONE = 0xFFFFFFFF;

const NAMESPACES = [null, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS];
const MODES = ["no-quirks", "quirks", "limited-quirks"];
const NS_CODES = new Map([[HTML_NS, 1], [SVG_NS, 2], [MATHML_NS, 3]]);

// Lone surrogates cannot cross the UTF-8 boundary to Rust losslessly.
const loneSurrogate = /\p{Surrogate}/u;

function canUseNative(markup) {
  return native !== null && !loneSurrogate.test(markup);
}

function replay(result, documentImpl, isFragment, root) {
  const { ops, strings } = result;
  const globalObject = documentImpl._globalObject;

  const nameCount = ops[0];
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    const off = ops[1 + i * 2];
    names[i] = strings.slice(off, off + ops[2 + i * 2]);
  }

  // Node id -> impl. Id 0 is the document (unused for fragments).
  const nodes = [];
  nodes[0] = documentImpl;
  if (root !== undefined) {
    nodes[result.root] = root;
  }

  let currentElement;
  const ownerDocument = () => {
    if (currentElement) {
      return currentElement.localName === "template" && currentElement.namespaceURI === HTML_NS ?
        currentElement.content._ownerDocument :
        currentElement._ownerDocument;
    }
    return documentImpl;
  };

  const insertText = (parentNode, text) => {
    const { lastChild } = parentNode;
    if (lastChild && lastChild.nodeType === nodeTypes.TEXT_NODE) {
      lastChild.data += text;
    } else {
      const textNode = Text.createImpl(globalObject, [], { data: text, ownerDocument: ownerDocument() });
      parentNode._append(textNode);
    }
  };

  const insertTextBefore = (referenceNode, text) => {
    const { previousSibling } = referenceNode;
    if (previousSibling && previousSibling.nodeType === nodeTypes.TEXT_NODE) {
      previousSibling.data += text;
    } else {
      const textNode = Text.createImpl(globalObject, [], { data: text, ownerDocument: ownerDocument() });
      referenceNode.parentNode._insert(textNode, referenceNode);
    }
  };

  // Applies `count` attributes starting at ops[i]; returns the index after them.
  const setAttributes = (element, i, count) => {
    for (let a = 0; a < count; a++, i += 5) {
      const off = ops[i + 3];
      attributes.setAttributeValue(
        element,
        names[ops[i]],
        strings.slice(off, off + ops[i + 4]),
        ops[i + 2] === 0 ? null : names[ops[i + 2]],
        NAMESPACES[ops[i + 1]]
      );
    }
    return i;
  };

  let i = 1 + nameCount * 2;
  const end = ops.length;
  while (i < end) {
    switch (ops[i]) {
      case OP_ELEMENT: {
        const id = ops[i + 1];
        const namespace = NAMESPACES[ops[i + 2]];
        const localName = names[ops[i + 3]];
        const attrCount = ops[i + 4];
        i += 5;

        const doc = ownerDocument();
        let isValue = null;
        for (let a = 0, j = i; a < attrCount; a++, j += 5) {
          if (names[ops[j]] === "is") {
            const off = ops[j + 3];
            isValue = strings.slice(off, off + ops[j + 4]);
            break;
          }
        }

        const willExecuteScript = !isFragment && lookupCEDefinition(doc, namespace, localName) !== null;
        if (willExecuteScript) {
          doc._throwOnDynamicMarkupInsertionCounter++;
          customElementReactionsStack.push([]);
        }

        const element = createElement(doc, localName, namespace, null, isValue, willExecuteScript);
        i = setAttributes(element, i, attrCount);

        if (willExecuteScript) {
          const queue = customElementReactionsStack.pop();
          invokeCEReactions(queue);
          doc._throwOnDynamicMarkupInsertionCounter--;
        }

        if ("_parserInserted" in element) {
          element._parserInserted = true;
        }

        nodes[id] = element;
        if (localName === "template" && namespace === HTML_NS) {
          // The Rust side allocates the template contents id right after the element's.
          nodes[id + 1] = element._templateContents;
        }
        break;
      }
      case OP_COMMENT: {
        const off = ops[i + 2];
        nodes[ops[i + 1]] = Comment.createImpl(globalObject, [], {
          data: strings.slice(off, off + ops[i + 3]),
          ownerDocument: ownerDocument()
        });
        i += 4;
        break;
      }
      case OP_APPEND:
        nodes[ops[i + 1]]._append(nodes[ops[i + 2]]);
        i += 3;
        break;
      case OP_APPEND_TEXT: {
        const off = ops[i + 2];
        insertText(nodes[ops[i + 1]], strings.slice(off, off + ops[i + 3]));
        i += 4;
        break;
      }
      case OP_INSERT_BEFORE: {
        const reference = nodes[ops[i + 1]];
        reference.parentNode._insert(nodes[ops[i + 2]], reference);
        i += 3;
        break;
      }
      case OP_INSERT_TEXT_BEFORE: {
        const off = ops[i + 2];
        insertTextBefore(nodes[ops[i + 1]], strings.slice(off, off + ops[i + 3]));
        i += 4;
        break;
      }
      case OP_DETACH:
        nodes[ops[i + 1]].remove();
        i += 2;
        break;
      case OP_REPARENT: {
        const donor = nodes[ops[i + 1]];
        const recipient = nodes[ops[i + 2]];
        for (let child = donor.firstChild; child; child = donor.firstChild) {
          child.remove();
          recipient._append(child);
        }
        i += 3;
        break;
      }
      case OP_PUSH: {
        const node = nodes[ops[i + 1]];
        currentElement = node;
        node._pushedOnStackOfOpenElements?.();
        i += 2;
        break;
      }
      case OP_POP: {
        const node = nodes[ops[i + 1]];
        const newTop = ops[i + 2];
        currentElement = newTop === NONE ? undefined : nodes[newTop];
        node._poppedOffStackOfOpenElements?.();
        i += 3;
        break;
      }
      case OP_DOCTYPE: {
        const name = strings.slice(ops[i + 1], ops[i + 1] + ops[i + 2]);
        const publicId = strings.slice(ops[i + 3], ops[i + 3] + ops[i + 4]);
        const systemId = strings.slice(ops[i + 5], ops[i + 5] + ops[i + 6]);
        const documentType = DocumentType.createImpl(globalObject, [], {
          name, publicId, systemId, ownerDocument: ownerDocument()
        });
        documentImpl._append(documentType);
        i += 7;
        break;
      }
      case OP_MODE:
        documentImpl._mode = MODES[ops[i + 1]];
        i += 2;
        break;
      case OP_ADD_ATTRS:
        i = setAttributes(nodes[ops[i + 1]], i + 3, ops[i + 2]);
        break;
      default:
        throw new Error(`Internal error: unknown native HTML parser instruction ${ops[i]}`);
    }
  }
}

function scriptingEnabled(documentImpl) {
  return documentImpl._parseOptions.scriptingEnabled !== false;
}

// Returns the DocumentFragment, or undefined if the native parser cannot be used for this input.
function parseFragment(markup, contextElement, ownerDocument) {
  if (!canUseNative(markup)) {
    return undefined;
  }

  // parse5 identifies the context element by its qualified name (and only treats it as HTML in the HTML namespace).
  const contextNS = NS_CODES.get(contextElement._namespaceURI) ?? 0;
  let contextAIP = false;
  if (contextNS === 3 && contextElement._localName === "annotation-xml") {
    const encoding = contextElement.getAttributeNS(null, "encoding");
    if (encoding !== null) {
      const lower = encoding.toLowerCase();
      contextAIP = lower === "text/html" || lower === "application/xhtml+xml";
    }
  }

  // https://html.spec.whatwg.org/#concept-frag-parse-context, as implemented by parse5 (qualified name "form").
  let hasForm = false;
  for (let node = contextElement; node; node = node.parentNode) {
    if (node._qualifiedName === "form") {
      hasForm = true;
      break;
    }
  }

  const result = native.parseHtmlFragment(
    markup,
    contextElement._qualifiedName,
    contextNS,
    contextAIP,
    hasForm,
    scriptingEnabled(ownerDocument)
  );

  const fragment = DocumentFragment.createImpl(ownerDocument._globalObject, [], { ownerDocument });
  replay(result, ownerDocument, true, fragment);
  return fragment;
}

const scriptsMayRunPattern = /<(?:script|iframe|frame|object|embed)/i;

// Returns true if the document was parsed natively; false if the caller must fall back to parse5.
function parseIntoDocument(markup, documentImpl) {
  if (!canUseNative(markup) || documentImpl._parseOptions.sourceCodeLocationInfo) {
    return false;
  }

  // Script can run in the middle of parsing (inline scripts executing when popped, custom element constructors,
  // nested browsing contexts). Replaying the instruction stream is faithful to parse5's sequence of tree operations, but
  // parse5 consults the live DOM when making tree construction decisions, which script could have modified. Keep the
  // incremental parse5 path whenever that is possible.
  const window = documentImpl._defaultView;
  if (window) {
    if (window._settings.runScripts === "dangerously" && scriptsMayRunPattern.test(markup)) {
      return false;
    }
    const registry = implForWrapper(documentImpl._globalObject._customElementRegistry);
    if (registry && registry._customElementDefinitions.length > 0) {
      return false;
    }
  }

  const result = native.parseHtmlDocument(markup, scriptingEnabled(documentImpl));
  replay(result, documentImpl, false);
  return true;
}

module.exports = {
  parseFragment,
  parseIntoDocument
};
