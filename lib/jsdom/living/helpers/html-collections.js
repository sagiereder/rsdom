"use strict";

const HTMLCollection = require("../../../generated/idl/HTMLCollection");
const NODE_TYPE = require("../node-type");
const orderedSetParse = require("./ordered-set").parse;
const { HTML_NS } = require("./namespaces");
const { asciiLowercase } = require("./strings");
const { nextInTree } = require("./dom-tree");

const { ELEMENT_NODE } = NODE_TYPE;

// These queries run on every rebuild of a live collection, so they walk the tree directly instead of going through
// `_descendantsToArray()` with a filter callback, and read the class attribute instead of allocating a DOMTokenList
// per element.

function classAttributeValue(el) {
  const list = el._attributeList;
  for (let i = 0; i < list.length; i++) {
    const attr = list[i];
    if (attr._localName === "class" && attr._namespace === null) {
      return attr._value;
    }
  }
  return null;
}

function isAsciiWhitespace(c) {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0C || c === 0x0D;
}

// Whether `token` is one of the ASCII-whitespace-separated tokens of `str`.
function hasToken(str, token) {
  const tlen = token.length;
  let from = 0;
  for (;;) {
    const i = str.indexOf(token, from);
    if (i === -1) {
      return false;
    }
    const end = i + tlen;
    if ((i === 0 || isAsciiWhitespace(str.charCodeAt(i - 1))) &&
        (end === str.length || isAsciiWhitespace(str.charCodeAt(end)))) {
      return true;
    }
    from = i + 1;
  }
}

function hasAllTokens(str, tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (!hasToken(str, tokens[i])) {
      return false;
    }
  }
  return true;
}

function descendantElements(root, predicate) {
  const result = [];
  for (let node = root.firstChild; node !== null; node = nextInTree(node, root)) {
    if (node.nodeType === ELEMENT_NODE && predicate(node)) {
      result.push(node);
    }
  }
  return result;
}

exports.createHTMLCollectionByClassNames = (classNames, root) => {
  // https://dom.spec.whatwg.org/#concept-getElementsByClassName

  const classes = [...orderedSetParse(classNames)];

  if (classes.length === 0) {
    return HTMLCollection.createImpl(root._globalObject, [], { element: root, query: () => [] });
  }

  const lowerClasses = classes.map(asciiLowercase);

  return HTMLCollection.createImpl(root._globalObject, [], {
    element: root,
    query: () => {
      const isQuirksMode = root._ownerDocument.compatMode === "BackCompat";
      const result = [];
      for (let node = root.firstChild; node !== null; node = nextInTree(node, root)) {
        if (node.nodeType !== ELEMENT_NODE) {
          continue;
        }
        const value = classAttributeValue(node);
        if (value === null) {
          continue;
        }
        if (isQuirksMode ? hasAllTokens(asciiLowercase(value), lowerClasses) : hasAllTokens(value, classes)) {
          result.push(node);
        }
      }
      return result;
    }
  });
};

exports.createHTMLCollectionByQualifiedName = (qualifiedName, root) => {
  // https://dom.spec.whatwg.org/#concept-getelementsbytagname

  if (qualifiedName === "*") {
    return HTMLCollection.createImpl(root._globalObject, [], {
      element: root,
      query: () => descendantElements(root, () => true)
    });
  }

  if (root._ownerDocument._parsingMode === "html") {
    const lowerQualifiedName = asciiLowercase(qualifiedName);

    return HTMLCollection.createImpl(root._globalObject, [], {
      element: root,
      query: () => descendantElements(root, node => {
        if (node._namespaceURI === HTML_NS) {
          return node._qualifiedName === lowerQualifiedName;
        }

        return node._qualifiedName === qualifiedName;
      })
    });
  }

  return HTMLCollection.createImpl(root._globalObject, [], {
    element: root,
    query: () => descendantElements(root, node => node._qualifiedName === qualifiedName)
  });
};

exports.createHTMLCollectionByNamespaceAndLocalName = (namespace, localName, root) => {
  // https://dom.spec.whatwg.org/#concept-getelementsbytagnamens

  if (namespace === "*" && localName === "*") {
    return HTMLCollection.createImpl(root._globalObject, [], {
      element: root,
      query: () => descendantElements(root, () => true)
    });
  }

  if (namespace === "*") {
    return HTMLCollection.createImpl(root._globalObject, [], {
      element: root,
      query: () => descendantElements(root, node => node._localName === localName)
    });
  }

  if (localName === "*") {
    return HTMLCollection.createImpl(root._globalObject, [], {
      element: root,
      query: () => descendantElements(root, node => node._namespaceURI === namespace)
    });
  }

  return HTMLCollection.createImpl(root._globalObject, [], {
    element: root,
    query: () => descendantElements(root, node => node._localName === localName && node._namespaceURI === namespace)
  });
};
