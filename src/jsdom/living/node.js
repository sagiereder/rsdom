"use strict";
const { appendAttribute } = require("./attributes");
const NODE_TYPE = require("./node-type");

const { createElement } = require("./helpers/create-element");
const { XML_NS, XMLNS_NS } = require("./helpers/namespaces");
const treeHelpers = require("./helpers/dom-tree");

// https://dom.spec.whatwg.org/#concept-node-clone
exports.clone = (node, document = node._ownerDocument, subtree = false, parent = null) => {
  const copy = cloneSingleNode(node, document);

  if (node._cloningSteps) {
    node._cloningSteps(copy, subtree);
  }

  if (parent !== null) {
    parent._append(copy);
  }

  if (subtree && node._links !== null && node._links.firstChild !== null) {
    if (copy.nodeType !== NODE_TYPE.DOCUMENT_NODE && !copy.isConnected) {
      cloneChildrenIntoDetachedCopy(node, copy, document);
    } else {
      for (const child of node._children()) {
        exports.clone(child, document, true, copy);
      }
    }
  }

  return copy;
};

let nodeImplPrototype = null;

// Clones the descendants of `node` into `copy`, in the same order as the recursive clone algorithm (each copied
// child is appended to its copied parent before its own children are cloned). `copy` and everything appended to it
// are new and not connected, so nothing can observe them yet: there are no registered mutation observers, live
// ranges, live collections, or shadow roots on them, and none of their nodes are connected. For such an append, the
// insert algorithm (https://dom.spec.whatwg.org/#concept-node-insert) does nothing beyond linking the node, except
// where a node has insertion steps (<option>, <input>, <base>, <link>, <style>) or its new parent has children changed
// steps (<script>, <style>, <textarea>). Those appends go through the full algorithm; the rest are linked directly.
function cloneChildrenIntoDetachedCopy(node, copy, document) {
  nodeImplPrototype ??= require("./nodes/Node-impl").implementation.prototype;
  const defaultChildrenInsertedSteps = nodeImplPrototype._childrenInsertedSteps;
  const defaultChildrenChangedSteps = nodeImplPrototype._childrenChangedSteps;

  let sourceParent = node;
  let copyParent = copy;
  let parentHasSteps = copyParent._childrenInsertedSteps !== defaultChildrenInsertedSteps ||
    copyParent._childrenChangedSteps !== defaultChildrenChangedSteps;
  let child = node._links.firstChild;
  // The copied parents of `sourceParent`'s ancestors, up to (excluding) `node`.
  const copyStack = [];

  while (true) {
    const childCopy = cloneSingleNode(child, document);
    if (child._cloningSteps) {
      child._cloningSteps(childCopy, true);
    }
    if (parentHasSteps || childCopy._insertionSteps !== undefined) {
      copyParent._append(childCopy);
    } else {
      treeHelpers.appendChild(copyParent, childCopy);
      copyParent._version++;
    }

    const childLinks = child._links;
    if (childLinks.firstChild !== null) {
      copyStack.push(copyParent, parentHasSteps);
      sourceParent = child;
      copyParent = childCopy;
      parentHasSteps = copyParent._childrenInsertedSteps !== defaultChildrenInsertedSteps ||
        copyParent._childrenChangedSteps !== defaultChildrenChangedSteps;
      child = childLinks.firstChild;
      continue;
    }

    child = childLinks.nextSibling;
    while (child === null) {
      if (sourceParent === node) {
        return;
      }
      child = sourceParent._links.nextSibling;
      sourceParent = sourceParent._links.parent;
      parentHasSteps = copyStack.pop();
      copyParent = copyStack.pop();
    }
  }
}

// https://dom.spec.whatwg.org/#clone-a-single-node
function cloneSingleNode(node, document) {
  let copy;
  switch (node.nodeType) {
    case NODE_TYPE.DOCUMENT_NODE:
      // Can't use a simple `Document.createImpl` because of circular dependency issues :-/
      copy = node._cloneDocument();
      break;

    case NODE_TYPE.DOCUMENT_TYPE_NODE:
      copy = document.implementation.createDocumentType(node.name, node.publicId, node.systemId);
      break;

    case NODE_TYPE.ELEMENT_NODE:
      copy = createElement(
        document,
        node._localName,
        node._namespaceURI,
        node._prefix,
        node._isValue,
        false
      );

      for (const attribute of node._attributeList) {
        appendAttribute(copy, cloneSingleNode(attribute, document));
      }
      break;

    case NODE_TYPE.ATTRIBUTE_NODE:
      copy = document._createAttribute({
        namespace: node._namespace,
        namespacePrefix: node._namespacePrefix,
        localName: node._localName,
        value: node._value
      });
      break;

    case NODE_TYPE.TEXT_NODE:
      copy = document.createTextNode(node._data);
      break;

    case NODE_TYPE.CDATA_SECTION_NODE:
      copy = document._createCDATASection(node._data);
      break;

    case NODE_TYPE.COMMENT_NODE:
      copy = document.createComment(node._data);
      break;

    case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      copy = document._createProcessingInstruction(node.target, node._data);
      break;

    case NODE_TYPE.DOCUMENT_FRAGMENT_NODE:
      copy = document.createDocumentFragment();
      break;
  }

  return copy;
}

// https://dom.spec.whatwg.org/#converting-nodes-into-a-node
// create a fragment (or just return a node for one item)
exports.convertNodesIntoNode = (document, nodes) => {
  if (nodes.length === 1) { // note: I'd prefer to check instanceof Node rather than string
    return typeof nodes[0] === "string" ? document.createTextNode(nodes[0]) : nodes[0];
  }
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < nodes.length; i++) {
    fragment._append(typeof nodes[i] === "string" ? document.createTextNode(nodes[i]) : nodes[i]);
  }
  return fragment;
};

// https://dom.spec.whatwg.org/#locate-a-namespace-prefix
exports.locateNamespacePrefix = (element, namespace) => {
  if (element._namespaceURI === namespace && element._prefix !== null) {
    return element._prefix;
  }

  for (const attribute of element._attributeList) {
    if (attribute._namespacePrefix === "xmlns" && attribute._value === namespace) {
      return attribute._localName;
    }
  }

  if (element.parentElement !== null) {
    return exports.locateNamespacePrefix(element.parentElement, namespace);
  }

  return null;
};

// https://dom.spec.whatwg.org/#locate-a-namespace
exports.locateNamespace = (node, prefix) => {
  switch (node.nodeType) {
    case NODE_TYPE.ELEMENT_NODE: {
      if (prefix === "xml") {
        return XML_NS;
      }

      if (prefix === "xmlns") {
        return XMLNS_NS;
      }

      if (node._namespaceURI !== null && node._prefix === prefix) {
        return node._namespaceURI;
      }

      if (prefix === null) {
        for (const attribute of node._attributeList) {
          if (attribute._namespace === XMLNS_NS &&
              attribute._namespacePrefix === null &&
              attribute._localName === "xmlns") {
            return attribute._value !== "" ? attribute._value : null;
          }
        }
      } else {
        for (const attribute of node._attributeList) {
          if (attribute._namespace === XMLNS_NS &&
              attribute._namespacePrefix === "xmlns" &&
              attribute._localName === prefix) {
            return attribute._value !== "" ? attribute._value : null;
          }
        }
      }

      if (node.parentElement === null) {
        return null;
      }

      return exports.locateNamespace(node.parentElement, prefix);
    }

    case NODE_TYPE.DOCUMENT_NODE: {
      if (node.documentElement === null) {
        return null;
      }

      return exports.locateNamespace(node.documentElement, prefix);
    }

    case NODE_TYPE.DOCUMENT_TYPE_NODE:
    case NODE_TYPE.DOCUMENT_FRAGMENT_NODE: {
      return null;
    }

    case NODE_TYPE.ATTRIBUTE_NODE: {
      if (node._element === null) {
        return null;
      }

      return exports.locateNamespace(node._element, prefix);
    }

    default: {
      if (node.parentElement === null) {
        return null;
      }

      return exports.locateNamespace(node.parentElement, prefix);
    }
  }
};
