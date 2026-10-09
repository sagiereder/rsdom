"use strict";
// Native (Rust/html5ever) HTML parsing. The addon parses the whole input in one call and returns a flat instruction
// stream (see native/src/html_parser.rs) that is replayed here, performing exactly the operations that jsdom's parse5
// tree adapter (./html.js) performs, in the same order.

const native = require("../../native");

const { createElement, getHTMLElementInterface } = require("../../living/helpers/create-element");
const { HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS } = require("../../living/helpers/namespaces");

const DocumentType = require("../../../generated/idl/DocumentType");
const DocumentFragment = require("../../../generated/idl/DocumentFragment");
const TextImpl = require("../../living/nodes/Text-impl").implementation;
const Comment = require("../../../generated/idl/Comment");
const AttrImpl = require("../../living/attributes/Attr-impl").implementation;

const attributes = require("../../living/attributes");
const treeHelpers = require("../../living/helpers/dom-tree");
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

// The most attributes appendNewAttributes() appends to one element; elements with more go through the generic path,
// which maintains the by-name index of elements with many attributes (see living/attributes.js).
const MAX_NEW_ATTRIBUTES = 8;

const NAMESPACES = [null, HTML_NS, SVG_NS, MATHML_NS, XLINK_NS, XML_NS, XMLNS_NS];
const MODES = ["no-quirks", "quirks", "limited-quirks"];
const NS_CODES = new Map([[HTML_NS, 1], [SVG_NS, 2], [MATHML_NS, 3]]);

// Lone surrogates cannot cross the UTF-8 boundary to Rust losslessly.
const loneSurrogate = /\p{Surrogate}/u;

function canUseNative(markup) {
  return native !== null && !loneSurrogate.test(markup);
}

// The name table follows the instructions; ops[0] holds its index.
function decodeNames(result) {
  const { ops, strings } = result;
  const table = ops[0];
  const nameCount = ops[table];
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    const off = ops[table + 1 + i * 2];
    names[i] = strings.slice(off, off + ops[table + 2 + i * 2]);
  }
  return names;
}

// The fast replay applies insertion effects in tree order once the tree is complete. That is not equivalent for
// checked radio buttons, where each insertion unchecks the others in its group present at that time. The name table
// holds every local and attribute name used, so it tells whether any element has a `checked` attribute.
function canReplayFast(names) {
  return !names.includes("checked");
}

// Replays the instruction stream. With `fast`, nodes are linked directly (the tree being built must be detached and
// unobservable: a fresh fragment, or a temporary container whose children are later inserted into the document), and
// the effects of the per-node insert algorithm that are observable on a detached tree are applied afterwards by
// finishDetachedTree(). Without it, every operation goes through the generic DOM insert/remove algorithms, exactly as
// the parse5 tree adapter does.
function replay(result, names, documentImpl, isFragment, root, fast, poppedScripts) {
  const { ops, strings } = result;
  const globalObject = documentImpl._globalObject;
  const nameCount = names.length;

  // Node id -> impl. Id 0 is the document (unused for fragments).
  const nodes = [];
  nodes[0] = documentImpl;
  if (root !== undefined) {
    nodes[isFragment ? result.root : 0] = root;
  }

  let currentElement;
  function ownerDocument() {
    if (currentElement) {
      return currentElement._localName === "template" && currentElement._namespaceURI === HTML_NS ?
        currentElement._templateContents._ownerDocument :
        currentElement._ownerDocument;
    }
    return documentImpl;
  }

  function createText(text) {
    // The wrapper is created lazily; see Text-impl.js.
    return new TextImpl(globalObject, [], { data: text, ownerDocument: ownerDocument() });
  }

  const insertText = fast ?
    (parentNode, text) => {
      const lastChild = parentNode._links?.lastChild;
      if (lastChild && lastChild.nodeType === nodeTypes.TEXT_NODE) {
        lastChild._data += text;
      } else {
        treeHelpers.appendChild(parentNode, createText(text));
      }
    } :
    (parentNode, text) => {
      const { lastChild } = parentNode;
      if (lastChild && lastChild.nodeType === nodeTypes.TEXT_NODE) {
        lastChild.data += text;
      } else {
        parentNode._append(createText(text));
      }
    };

  const insertTextBefore = fast ?
    (referenceNode, text) => {
      const { previousSibling } = referenceNode;
      if (previousSibling && previousSibling.nodeType === nodeTypes.TEXT_NODE) {
        previousSibling._data += text;
      } else {
        treeHelpers.insertBefore(referenceNode, createText(text));
      }
    } :
    (referenceNode, text) => {
      const { previousSibling } = referenceNode;
      if (previousSibling && previousSibling.nodeType === nodeTypes.TEXT_NODE) {
        previousSibling.data += text;
      } else {
        referenceNode.parentNode._insert(createText(text), referenceNode);
      }
    };

  const append = fast ?
    (parent, child) => {
      if (child.parentNode !== null) {
        treeHelpers.remove(child);
      }
      treeHelpers.appendChild(parent, child);
    } :
    (parent, child) => parent._append(child);

  const insertBefore = fast ?
    (reference, child) => {
      if (child.parentNode !== null) {
        treeHelpers.remove(child);
      }
      treeHelpers.insertBefore(reference, child);
    } :
    (reference, child) => reference.parentNode._insert(child, reference);

  const detach = fast ? node => treeHelpers.remove(node) : node => node.remove();

  // Per name id: the interface of HTML elements with that local name, when creating one involves no custom element
  // logic (see createHTMLElement()); false otherwise.
  const htmlInterfaces = new Array(nameCount);

  // Equivalent to createElement(doc, localName, HTML_NS) for a local name without "-" and no `is` value: such an
  // element cannot be custom, and its custom element state is "uncustomized". Returns null for other names.
  function createHTMLElement(doc, nameId) {
    let elementInterface = htmlInterfaces[nameId];
    if (elementInterface === undefined) {
      const localName = names[nameId];
      elementInterface = localName.includes("-") ? false : getHTMLElementInterface(localName);
      htmlInterfaces[nameId] = elementInterface;
    }
    if (elementInterface === false) {
      return null;
    }
    return elementInterface.createImpl(globalObject, [], {
      ownerDocument: doc,
      localName: names[nameId],
      namespace: HTML_NS,
      prefix: null,
      ceState: "uncustomized",
      ceDefinition: null,
      isValue: null
    });
  }

  // Appends the attributes of a newly created, uncustomized element without a parent, which the tokenizer has already
  // deduplicated. Equivalent to setAttributes(), but skipping the steps that cannot have an effect then: looking for
  // an existing attribute, mutation records (no observer can be registered on the element or an ancestor yet), and
  // custom element reactions. Few enough attributes are appended that the element does not index them by name yet.
  function appendNewAttributes(element, i, count) {
    const attributeList = element._attributeList;
    const ownerDoc = element._ownerDocument;
    for (let a = 0; a < count; a++, i += 5) {
      const off = ops[i + 3];
      const localName = names[ops[i]];
      const value = strings.slice(off, off + ops[i + 4]);
      const namespace = NAMESPACES[ops[i + 1]];
      // The wrapper is created lazily; see Attr-impl.js.
      attributeList.push(new AttrImpl(globalObject, [], {
        namespace,
        namespacePrefix: ops[i + 2] === 0 ? null : names[ops[i + 2]],
        localName,
        value,
        element,
        ownerDocument: ownerDoc
      }));
      element._attributeChangeSteps(localName, null, value, namespace);
    }
    return i;
  }

  // Applies `count` attributes starting at ops[i]; returns the index after them.
  function setAttributes(element, i, count) {
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
  }

  let i = 1;
  const end = ops[0];
  while (i < end) {
    switch (ops[i]) {
      case OP_ELEMENT: {
        const id = ops[i + 1];
        const namespace = NAMESPACES[ops[i + 2]];
        const nameId = ops[i + 3];
        const localName = names[nameId];
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

        const fastElement = isValue === null && namespace === HTML_NS ? createHTMLElement(doc, nameId) : null;
        if (fastElement !== null) {
          i = attrCount <= MAX_NEW_ATTRIBUTES ?
            appendNewAttributes(fastElement, i, attrCount) :
            setAttributes(fastElement, i, attrCount);
          if ("_parserInserted" in fastElement) {
            fastElement._parserInserted = true;
          }
          nodes[id] = fastElement;
          if (localName === "template") {
            nodes[id + 1] = fastElement._templateContents;
          }
          break;
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
        append(nodes[ops[i + 1]], nodes[ops[i + 2]]);
        i += 3;
        break;
      case OP_APPEND_TEXT: {
        const off = ops[i + 2];
        insertText(nodes[ops[i + 1]], strings.slice(off, off + ops[i + 3]));
        i += 4;
        break;
      }
      case OP_INSERT_BEFORE: {
        insertBefore(nodes[ops[i + 1]], nodes[ops[i + 2]]);
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
        detach(nodes[ops[i + 1]]);
        i += 2;
        break;
      case OP_REPARENT: {
        const donor = nodes[ops[i + 1]];
        const recipient = nodes[ops[i + 2]];
        for (let child = donor.firstChild; child; child = donor.firstChild) {
          detach(child);
          append(recipient, child);
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
        if (poppedScripts !== undefined && node._localName === "script" && node._namespaceURI === HTML_NS) {
          // Popping a script prepares it only once it is connected; see parseIntoDocument().
          poppedScripts.push(node);
        } else {
          node._poppedOffStackOfOpenElements?.();
        }
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
        append(nodes[0], documentType);
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

// Applies, to a tree built by a fast replay, the effects that inserting each node one at a time would have had while
// the tree was detached. Of the insert algorithm's steps (https://dom.spec.whatwg.org/#concept-node-insert), only these
// do anything for nodes that are not connected and cannot be observed yet:
//  - collection/version cache invalidation;
//  - the insertion steps (<option> asks its <select> for a reset; <base> clears the base URL cache), when
//    `runInsertionSteps` (otherwise the caller inserts the tree into a document, which runs them);
//  - the children inserted/changed steps (<textarea> takes its raw value from its child text).
// All of these depend only on the final tree, so applying them once, in tree order, gives the same result.
function finishDetachedTree(root, runInsertionSteps) {
  root._version++;
  root._childrenList?._invalidate();
  root._childNodesList?._invalidate();

  // Explicit stack instead of recursion: the parser can produce arbitrarily deep trees. Every node below `root` is in
  // the tree, so it has links (see dom-tree.js).
  const stack = [];
  let node = root.firstChild;
  while (node !== null) {
    const links = node._links;
    node._version++;
    if (node.nodeType === nodeTypes.ELEMENT_NODE) {
      if (runInsertionSteps && node._insertionSteps) {
        node._insertionSteps();
      }
      if (node._localName === "template" && node._namespaceURI === HTML_NS) {
        // Template contents are a separate (never connected) tree.
        finishDetachedTree(node._templateContents, true);
      }
    }

    const { firstChild } = links;
    if (firstChild !== null) {
      node._childrenList?._invalidate();
      node._childNodesList?._invalidate();
      node._childrenInsertedSteps();
      stack.push(node);
      node = firstChild;
      continue;
    }
    let next = links.nextSibling;
    while (next === null && stack.length > 0) {
      next = stack.pop()._links.nextSibling;
    }
    node = next;
  }
  root._childrenInsertedSteps();
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
  const names = decodeNames(result);
  if (canReplayFast(names)) {
    // The fragment is new, so nothing can observe it while it is being built.
    replay(result, names, ownerDocument, true, fragment, true);
    finishDetachedTree(fragment, true);
  } else {
    replay(result, names, ownerDocument, true, fragment, false);
  }
  return fragment;
}

const scriptsMayRunPattern = /<(?:script|iframe|frame|object|embed)/i;

// Returns true if the document was parsed natively; false if the caller must fall back to parse5.
function parseIntoDocument(markup, documentImpl) {
  if (!canUseNative(markup) || documentImpl._parseOptions.sourceCodeLocationInfo) {
    return false;
  }

  // Script can run in the middle of parsing (inline scripts executing when popped, custom element constructors,
  // nested browsing contexts). Replaying the instruction stream is faithful to parse5's sequence of tree operations,
  // but parse5 consults the live DOM when making tree construction decisions, which script could have modified. Keep
  // the incremental parse5 path whenever that is possible.
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

  const names = decodeNames(result);

  // Mutation observers on the document would see one record per top-level node instead of one per parser insertion.
  const observers = documentImpl._registeredObserverList;
  if (!canReplayFast(names) || (observers !== null && observers.length > 0)) {
    replay(result, names, documentImpl, false);
    return true;
  }

  // Build the tree detached, in a temporary container, then insert each top-level node into the document with the
  // generic insert algorithm, which runs the connected insertion steps, document caches, and post-connection steps for
  // the whole subtree. Scripts popped off the stack while detached are prepared once connected, in parser order (they
  // cannot run here: that case uses parse5 above).
  const container = DocumentFragment.createImpl(documentImpl._globalObject, [], { ownerDocument: documentImpl });
  const poppedScripts = [];
  replay(result, names, documentImpl, false, container, true, poppedScripts);
  finishDetachedTree(container, false);
  if (documentImpl._defaultView && !names.includes("base")) {
    // Connecting a <style> or <link> computes (and caches) the document base URL by searching the document for
    // <base href>. Inserting incrementally, that search happens while the document is nearly empty; here the whole
    // tree would be searched. No <base> is being inserted, so the result is the same either way.
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

module.exports = {
  parseFragment,
  parseIntoDocument
};
