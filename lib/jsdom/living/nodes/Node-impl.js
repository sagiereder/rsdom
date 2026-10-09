"use strict";

const DOMException = require("../../../generated/idl/DOMException");

const EventTargetImpl = require("../events/EventTarget-impl").implementation;
const { defineFieldDefaults } = require("../../utils");
const NODE_TYPE = require("../node-type");
const { HTML_NS } = require("../helpers/namespaces");
const NODE_DOCUMENT_POSITION = require("../node-document-position");
const { clone, locateNamespacePrefix, locateNamespace } = require("../node");
const {
  createHTMLCollectionByClassNames,
  createHTMLCollectionByQualifiedName,
  createHTMLCollectionByNamespaceAndLocalName
} = require("../helpers/html-collections");
const { setAnExistingAttributeValue } = require("../attributes");

const NodeList = require("../../../generated/idl/NodeList");

const treeHelpers = require("../helpers/dom-tree");
const { LINK_ELEMENT, LINK_STEPS, LINK_CUSTOM_ELEMENT, LINK_ID_OR_NAME, LINK_VERSION_OBSERVED } = treeHelpers;
const fastPathFlags = require("../helpers/fast-path-flags");
const windowProperties = require("../window-properties");
const { isNamedPropertyElement } = require("../helpers/document-named-properties");
const { queueTreeMutationRecord } = require("../helpers/mutation-observers");
const { enqueueCECallbackReaction, tryUpgradeElement } = require("../helpers/custom-elements");
const {
  updateRadioButtonGroupsForTreeChange,
  updateRadioButtonGroupsForInsertedInputs
} = require("../helpers/form-controls");
const mutationJournal = require("../helpers/mutation-journal");
const {
  isShadowRoot, shadowIncludingRoot, assignSlot, assignSlotableForTree, assignSlotable, signalSlotChange, isSlot
} = require("../helpers/shadow-dom");

function nodeEquals(a, b) {
  if (a.nodeType !== b.nodeType) {
    return false;
  }

  switch (a.nodeType) {
    case NODE_TYPE.DOCUMENT_TYPE_NODE:
      if (a.name !== b.name || a.publicId !== b.publicId ||
          a.systemId !== b.systemId) {
        return false;
      }
      break;
    case NODE_TYPE.ELEMENT_NODE:
      if (a._namespaceURI !== b._namespaceURI || a._prefix !== b._prefix || a._localName !== b._localName ||
          a._attributeList.length !== b._attributeList.length) {
        return false;
      }
      break;
    case NODE_TYPE.ATTRIBUTE_NODE:
      if (a._namespace !== b._namespace || a._localName !== b._localName || a._value !== b._value) {
        return false;
      }
      break;
    case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      if (a._target !== b._target || a._data !== b._data) {
        return false;
      }
      break;
    case NODE_TYPE.TEXT_NODE:
    case NODE_TYPE.COMMENT_NODE:
      if (a._data !== b._data) {
        return false;
      }
      break;
  }

  if (a.nodeType === NODE_TYPE.ELEMENT_NODE && !attributeListsEqual(a, b)) {
    return false;
  }

  if (a._childCount !== b._childCount) {
    return false;
  }

  for (let childA = a.firstChild, childB = b.firstChild; childA !== null;
    childA = childA.nextSibling, childB = childB.nextSibling) {
    if (!nodeEquals(childA, childB)) {
      return false;
    }
  }

  return true;
}

// Needed by https://dom.spec.whatwg.org/#concept-node-equals
function attributeListsEqual(elementA, elementB) {
  const listA = elementA._attributeList;
  const listB = elementB._attributeList;

  const lengthA = listA.length;
  const lengthB = listB.length;

  if (lengthA !== lengthB) {
    return false;
  }

  for (let i = 0; i < lengthA; ++i) {
    const attrA = listA[i];

    if (!listB.some(attrB => nodeEquals(attrA, attrB))) {
      return false;
    }
  }

  return true;
}

const EMPTY_SET = new Set();
const EMPTY_ARRAY = Object.freeze([]);

// Set by `connectSubtree()` when it runs any element's insertion steps.
let connectRanInsertionSteps = false;
// The node `_insert()` is moving within the connected tree without disconnecting it, while `_adoptNode()` removes it.
let keepConnectedNode = null;

function createMemoizedQueries() {
  // These all derive from a node's subtree and are discarded together after any tree or attribute mutation.
  return {
    collectionsByClassNames: null,
    collectionsByQualifiedName: null,
    collectionsByNamespaceAndLocalName: null,
    labelAssociations: null
  };
}

// https://dom.spec.whatwg.org/#concept-tree-host-including-inclusive-ancestor
function isHostInclusiveAncestor(nodeImplA, nodeImplB) {
  // A node without children, shadow trees or template contents is only a host-including inclusive ancestor of itself.
  if (nodeImplA === nodeImplB) {
    return true;
  }
  if (!fastPathFlags.shadowRoots && (nodeImplA._links?.firstChild ?? null) === null &&
    nodeImplA._templateContents === undefined) {
    return false;
  }
  let rootImplB = nodeImplB;
  for (let ancestor = nodeImplB; ancestor !== null; ancestor = ancestor.parentNode) {
    if (ancestor === nodeImplA) {
      return true;
    }
    rootImplB = ancestor;
  }
  if (rootImplB._host) {
    return isHostInclusiveAncestor(nodeImplA, rootImplB._host);
  }

  return false;
}

// Call these helpers before running element-specific steps, so `document.getElementById()` and `window[name]`
// see updated caches for the entire subtree.
function addSubtreeToDocumentCaches(root) {
  const document = root._ownerDocument;
  const tracker = windowProperties.trackerForDocument(document);
  let affectsNamedProperties = false;

  for (let node = root; node !== null; node = treeHelpers.nextInTree(node, root)) {
    node._isInDocumentTree = true;
    // The named property, window named property and id caches only hold elements with an id or name attribute.
    if (node.nodeType === NODE_TYPE.ELEMENT_NODE && node._attributeList.length !== 0) {
      const id = node.getAttributeNS(null, "id");
      if (tracker !== undefined) {
        windowProperties.elementAttached(tracker, node, id);
      }
      if (id) {
        document._byIdCache.add(id, node);
      }
      affectsNamedProperties ||= isNamedPropertyElement(node) &&
        (Boolean(id) || Boolean(node.getAttributeNS(null, "name")));
    }
  }

  if (affectsNamedProperties) {
    document._clearNamedPropertyCache();
  }
}

function removeSubtreeFromDocumentCaches(root) {
  const document = root._ownerDocument;
  const tracker = windowProperties.trackerForDocument(document);

  for (let node = root; node !== null; node = treeHelpers.nextInTree(node, root)) {
    node._isInDocumentTree = false;
    // The removed subtree's root is no longer the document. Skip the write when the prototype default is in effect,
    // which keeps from giving every removed node its own property.
    if (node._cachedRoot !== null) {
      node._cachedRoot = null;
    }
    // The named property, window named property and id caches only hold elements with an id or name attribute.
    if (node.nodeType === NODE_TYPE.ELEMENT_NODE && node._attributeList.length !== 0) {
      if (isNamedPropertyElement(node)) {
        document._namedPropertyElementRemoved(node);
      }
      const id = node.getAttributeNS(null, "id");
      if (tracker !== undefined) {
        windowProperties.elementDetached(tracker, node, id);
      }
      if (id) {
        document._byIdCache.delete(id, node);
      }
    }
  }
}

function runInsertionStepsFor(inclusiveDescendant) {
  if (inclusiveDescendant._insertionSteps) {
    inclusiveDescendant._insertionSteps();
  }

  if (inclusiveDescendant.nodeType === NODE_TYPE.ELEMENT_NODE && inclusiveDescendant.isConnected) {
    if (inclusiveDescendant._ceState === "custom") {
      enqueueCECallbackReaction(inclusiveDescendant, "connectedCallback", []);
    } else {
      tryUpgradeElement(inclusiveDescendant);
    }
  }
}

class NodeImpl extends EventTargetImpl {
  // Fields that most nodes never write have their defaults on the prototype (see the end of this file). Node
  // constructors run for many classes, so each store here is a megamorphic, map-transitioning store; keeping them few
  // makes node creation much cheaper.
  constructor(globalObject, args, privateData) {
    super(globalObject, args, privateData);

    this._links = null;
    this._ownerDocument = privateData.ownerDocument;
    this._version = 0;
    // This cached flag deliberately excludes shadow trees. Use `isConnected` for shadow-including connectedness.
    this._isInDocumentTree = false;
  }

  // Generator that yields live Range objects from _referencedRanges,
  // cleaning up any dead WeakRefs encountered during iteration.
  * _liveRanges() {
    if (this._referencedRanges === null) {
      return;
    }

    for (const weakRef of this._referencedRanges) {
      const range = weakRef.deref();
      if (range) {
        yield range;
      } else {
        // Range was garbage collected - remove the dead WeakRef
        this._referencedRanges.delete(weakRef);
      }
    }
  }

  _getMemoizedQueries() {
    if (this._memoizedQueries === null) {
      treeHelpers.observeVersion(this);
      this._memoizedQueries = createMemoizedQueries();
    }
    return this._memoizedQueries;
  }

  _clearMemoizedQueries() {
    this._memoizedQueries = null;
  }

  getElementsByClassName(classNames) {
    const memoizedQueries = this._getMemoizedQueries();
    let collections = memoizedQueries.collectionsByClassNames;
    if (collections === null) {
      collections = new Map();
      memoizedQueries.collectionsByClassNames = collections;
    }

    let collection = collections.get(classNames);
    if (collection === undefined) {
      collection = createHTMLCollectionByClassNames(classNames, this);
      collections.set(classNames, collection);
    }
    return collection;
  }

  getElementsByTagName(qualifiedName) {
    const memoizedQueries = this._getMemoizedQueries();
    let collections = memoizedQueries.collectionsByQualifiedName;
    if (collections === null) {
      collections = new Map();
      memoizedQueries.collectionsByQualifiedName = collections;
    }

    let collection = collections.get(qualifiedName);
    if (collection === undefined) {
      collection = createHTMLCollectionByQualifiedName(qualifiedName, this);
      collections.set(qualifiedName, collection);
    }
    return collection;
  }

  getElementsByTagNameNS(namespace, localName) {
    if (namespace === "") {
      namespace = null;
    }

    const memoizedQueries = this._getMemoizedQueries();
    let collectionsByNamespace = memoizedQueries.collectionsByNamespaceAndLocalName;
    if (collectionsByNamespace === null) {
      collectionsByNamespace = new Map();
      memoizedQueries.collectionsByNamespaceAndLocalName = collectionsByNamespace;
    }

    let collectionsByLocalName = collectionsByNamespace.get(namespace);
    if (collectionsByLocalName === undefined) {
      collectionsByLocalName = new Map();
      collectionsByNamespace.set(namespace, collectionsByLocalName);
    }

    let collection = collectionsByLocalName.get(localName);
    if (collection === undefined) {
      collection = createHTMLCollectionByNamespaceAndLocalName(namespace, localName, this);
      collectionsByLocalName.set(localName, collection);
    }
    return collection;
  }

  _getTheParent() {
    if (this._assignedSlot) {
      return this._assignedSlot;
    }

    return this.parentNode;
  }

  get parentNode() {
    return this._links?.parent ?? null;
  }

  _treeIndex() {
    return treeHelpers.treeIndex(this);
  }

  // https://dom.spec.whatwg.org/#concept-node-length
  // Overridden by `CharacterDataImpl` to return the data's UTF-16 length instead of the child count.
  get _length() {
    return this._childCount;
  }

  get _childCount() {
    return this._links?.childCount ?? 0;
  }

  _children() {
    return new treeHelpers.ChildrenIterator(this.firstChild);
  }

  _descendants() {
    return new treeHelpers.DescendantsIterator(this, this.firstChild);
  }

  _inclusiveDescendants() {
    return new treeHelpers.DescendantsIterator(this, this);
  }

  _childrenToArray(filter) {
    return treeHelpers.childrenToArray(this, filter);
  }

  _descendantsToArray(filter) {
    return treeHelpers.descendantsToArray(this, this.firstChild, filter);
  }

  _inclusiveDescendantsToArray(filter) {
    return treeHelpers.descendantsToArray(this, this, filter);
  }

  _shadowIncludingDescendants() {
    const iterator = this._shadowIncludingInclusiveDescendants();
    iterator.next();
    return iterator;
  }

  _shadowIncludingInclusiveDescendants() {
    return new treeHelpers.ShadowIncludingIterator(this);
  }

  _nextInTree(root = null) {
    return treeHelpers.nextInTree(this, root);
  }

  _nextAfterSubtree(root = null) {
    return treeHelpers.nextAfterSubtree(this, root);
  }

  _previousInTree(root = null) {
    return treeHelpers.previousInTree(this, root);
  }

  _lastInclusiveDescendant() {
    return treeHelpers.lastInclusiveDescendant(this);
  }

  _compareTreePosition(other) {
    return treeHelpers.compareTreePosition(this, other);
  }

  _commonAncestorInfo(other) {
    return treeHelpers.commonAncestorInfo(this, other);
  }

  getRootNode(options) {
    if (options?.composed) {
      return shadowIncludingRoot(this);
    }

    if (this._cachedRoot !== null) {
      return this._cachedRoot;
    }

    // Stop at the root or at an ancestor whose root is already cached.
    let root = this;
    let parent;
    while (root._cachedRoot === null && (parent = root.parentNode) !== null) {
      root = parent;
    }
    root = root._cachedRoot ?? root;

    // Cache only Document roots: `_remove()` invalidates descendant caches when the old parent is connected.
    // Detached trees do not receive that invalidation, so their roots must not be cached. Stop filling the path
    // once it reaches a node already cached, so later reads anywhere along this path are constant-time.
    if (root.nodeType === NODE_TYPE.DOCUMENT_NODE) {
      root._cachedRoot = root;
      for (let current = this; current._cachedRoot !== root; current = current.parentNode) {
        current._cachedRoot = root;
      }
    }

    return root;
  }

  get nodeName() {
    switch (this.nodeType) {
      case NODE_TYPE.ELEMENT_NODE:
        return this.tagName;
      case NODE_TYPE.ATTRIBUTE_NODE:
        return this._qualifiedName;
      case NODE_TYPE.TEXT_NODE:
        return "#text";
      case NODE_TYPE.CDATA_SECTION_NODE:
        return "#cdata-section";
      case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
        return this.target;
      case NODE_TYPE.COMMENT_NODE:
        return "#comment";
      case NODE_TYPE.DOCUMENT_NODE:
        return "#document";
      case NODE_TYPE.DOCUMENT_TYPE_NODE:
        return this.name;
      case NODE_TYPE.DOCUMENT_FRAGMENT_NODE:
        return "#document-fragment";
    }

    // should never happen
    return null;
  }

  get firstChild() {
    return this._links?.firstChild ?? null;
  }

  // https://dom.spec.whatwg.org/#connected
  // https://dom.spec.whatwg.org/#dom-node-isconnected
  get isConnected() {
    // `_isInDocumentTree` is exact for nodes outside shadow trees, and no node is in a shadow tree until a shadow root
    // has been created.
    if (this._isInDocumentTree) {
      return true;
    }
    if (!fastPathFlags.shadowRoots) {
      return false;
    }
    const root = shadowIncludingRoot(this);
    return root && root.nodeType === NODE_TYPE.DOCUMENT_NODE;
  }

  get ownerDocument() {
    return this.nodeType === NODE_TYPE.DOCUMENT_NODE ? null : this._ownerDocument;
  }

  get lastChild() {
    return this._links?.lastChild ?? null;
  }

  get childNodes() {
    if (!this._childNodesList) {
      this._childNodesList = NodeList.createImpl(this._globalObject, [], {
        element: this,
        query: () => this._childrenToArray()
      });
    } else {
      this._childNodesList._update();
    }

    return this._childNodesList;
  }

  get nextSibling() {
    return this._links?.nextSibling ?? null;
  }

  get previousSibling() {
    return this._links?.previousSibling ?? null;
  }

  // Selector-visible state can affect styles anywhere in the document, without changing structural collections.
  _invalidateSelectorState() {
    this._ownerDocument._clearDOMSelector();
    if (this.isConnected) {
      this._ownerDocument._clearStyleCache();
    }
  }

  // Call this before running element-specific steps, so collection and style reads reflect the mutation.
  // `kind`, `node`, and `name` describe the mutation for incremental live collection updates (see
  // ../helpers/mutation-journal.js); callers that don't pass them force those collections to rebuild.
  _invalidateCaches(kind = mutationJournal.OTHER, node = null, name = null) {
    const document = this._ownerDocument;
    document._mutationJournal?.record(kind, this, node, name);
    // Only the versions that something checks need bumping, and only nodes with links can be observed. Walking the
    // links objects avoids reading the many-shaped node objects.
    for (let links = this._links; links !== null; links = links.parentLinks) {
      if (links.flags & LINK_VERSION_OBSERVED) {
        const ancestor = links.node;
        ancestor._version++;
        if (ancestor._memoizedQueries !== null) {
          ancestor._memoizedQueries = null;
        }
        if (ancestor === this) {
          this._childrenList?._invalidate();
          this._childNodesList?._invalidate();
        }
      }
    }

    if (this._isInDocumentTree || (fastPathFlags.shadowRoots && this.isConnected)) {
      document._clearStyleCache();
    }
  }

  // Lifecycle hook overrides must chain to any inherited implementation, in the order documented on that hook.
  // Hooks without shared work, such as `_insertionSteps`, `_postConnectionSteps`, and `_cloningSteps`, have no base
  // implementation; callers check for their presence. In particular, insertion collects only nodes with actual
  // post-connection work.

  // Overrides call `super` first to invalidate styles before doing element-specific work.
  _childrenChangedSteps() {
    if (this.isConnected) {
      this._ownerDocument._clearStyleCache();
    }
  }

  // https://dom.spec.whatwg.org/#concept-node-children-inserted-ext, introduced in
  // https://github.com/whatwg/dom/pull/1460. Insert runs these in place of the children changed
  // steps when a subclass defines them, so the default is to run the children changed steps.
  // Overrides call `super` first to preserve those steps before doing insertion-only work.
  _childrenInsertedSteps() {
    this._childrenChangedSteps();
  }

  // https://html.spec.whatwg.org/multipage/infrastructure.html#dom-trees:concept-node-remove-ext
  // Overrides call `super` first: focus fixup precedes HTML element removing steps.
  _removingSteps() {
    if (this._ownerDocument._lastFocusedElement === this) {
      // Represent the viewport with the Document so that activeElement resolves to the body (or document element)
      // while hasFocus() remains true. Removal does not run unfocusing steps or fire blur/change events.
      this._ownerDocument._lastFocusedElement = this._ownerDocument;
    }
  }

  hasChildNodes() {
    return this.firstChild !== null;
  }

  // https://dom.spec.whatwg.org/#dom-node-normalize
  normalize() {
    // Snapshot the subtree before merging and removing text nodes.
    for (const node of this._descendantsToArray()) {
      const { parentNode } = node;
      if (parentNode === null || node.nodeType !== NODE_TYPE.TEXT_NODE) {
        continue;
      }

      let length = node._length;

      if (length === 0) {
        parentNode._remove(node);
        continue;
      }

      const continuousExclusiveTextNodes = [];

      for (let currentNode = node.previousSibling; currentNode !== null; currentNode = currentNode.previousSibling) {
        if (currentNode.nodeType !== NODE_TYPE.TEXT_NODE) {
          break;
        }

        continuousExclusiveTextNodes.unshift(currentNode);
      }
      for (let currentNode = node.nextSibling; currentNode !== null; currentNode = currentNode.nextSibling) {
        if (currentNode.nodeType !== NODE_TYPE.TEXT_NODE) {
          break;
        }

        continuousExclusiveTextNodes.push(currentNode);
      }

      const data = continuousExclusiveTextNodes.reduce((d, n) => d + n._data, "");
      node.replaceData(length, 0, data);

      let currentNode = node.nextSibling;
      while (currentNode && currentNode.nodeType === NODE_TYPE.TEXT_NODE) {
        const currentNodeIndex = currentNode._treeIndex();

        for (const range of node._liveRanges()) {
          const { _start, _end } = range;

          if (_start.node === currentNode) {
            range._setLiveRangeStart(node, _start.offset + length);
          }
          if (_end.node === currentNode) {
            range._setLiveRangeEnd(node, _end.offset + length);
          }
        }

        for (const range of parentNode._liveRanges()) {
          const { _start, _end } = range;

          if (_start.node === parentNode && _start.offset === currentNodeIndex) {
            range._setLiveRangeStart(node, length);
          }
          if (_end.node === parentNode && _end.offset === currentNodeIndex) {
            range._setLiveRangeEnd(node, length);
          }
        }

        length += currentNode._length;
        currentNode = currentNode.nextSibling;
      }

      for (const continuousExclusiveTextNode of continuousExclusiveTextNodes) {
        parentNode._remove(continuousExclusiveTextNode);
      }
    }
  }

  get parentElement() {
    const { parentNode } = this;
    return parentNode !== null && parentNode.nodeType === NODE_TYPE.ELEMENT_NODE ? parentNode : null;
  }

  get baseURI() {
    return this._ownerDocument.baseURLSerialized();
  }

  compareDocumentPosition(other) {
    // Let node1 be other and node2 be the context object.
    let node1 = other;
    let node2 = this;

    let attr1 = null;
    let attr2;

    if (node1.nodeType === NODE_TYPE.ATTRIBUTE_NODE) {
      attr1 = node1;
      node1 = attr1._element;
    }

    if (node2.nodeType === NODE_TYPE.ATTRIBUTE_NODE) {
      attr2 = node2;
      node2 = attr2._element;

      if (attr1 !== null && node1 !== null && node2 === node1) {
        for (const attr of node2._attributeList) {
          if (nodeEquals(attr, attr1)) {
            return NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC |
              NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_PRECEDING;
          }

          if (nodeEquals(attr, attr2)) {
            return NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC |
              NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_FOLLOWING;
          }
        }
      }
    }

    const result = treeHelpers.compareTreePosition(node2, node1);

    // “If other and reference are not in the same tree, return the result of adding DOCUMENT_POSITION_DISCONNECTED,
    //  DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC, and either DOCUMENT_POSITION_PRECEDING or
    // DOCUMENT_POSITION_FOLLOWING, with the constraint that this is to be consistent, together.”
    if (result === NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_DISCONNECTED) {
      // Disconnected tree positions need these additional bits required by the spec:
      return NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_DISCONNECTED |
        NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC |
        NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_FOLLOWING;
    }

    return result;
  }

  lookupPrefix(namespace) {
    if (namespace === null || namespace === "") {
      return null;
    }

    switch (this.nodeType) {
      case NODE_TYPE.ELEMENT_NODE: {
        return locateNamespacePrefix(this, namespace);
      }
      case NODE_TYPE.DOCUMENT_NODE: {
        return this.documentElement !== null ? locateNamespacePrefix(this.documentElement, namespace) : null;
      }
      case NODE_TYPE.DOCUMENT_TYPE_NODE:
      case NODE_TYPE.DOCUMENT_FRAGMENT_NODE: {
        return null;
      }
      case NODE_TYPE.ATTRIBUTE_NODE: {
        return this._element !== null ? locateNamespacePrefix(this._element, namespace) : null;
      }
      default: {
        return this.parentElement !== null ? locateNamespacePrefix(this.parentElement, namespace) : null;
      }
    }
  }

  lookupNamespaceURI(prefix) {
    if (prefix === "") {
      prefix = null;
    }

    return locateNamespace(this, prefix);
  }

  isDefaultNamespace(namespace) {
    if (namespace === "") {
      namespace = null;
    }

    const defaultNamespace = locateNamespace(this, null);
    return defaultNamespace === namespace;
  }

  contains(other) {
    while (other !== null) {
      if (this === other) {
        return true;
      }
      other = other.parentNode;
    }
    return false;
  }

  isEqualNode(node) {
    if (node === null) {
      return false;
    }

    // Fast-path, not in the spec
    if (this === node) {
      return true;
    }

    return nodeEquals(this, node);
  }

  isSameNode(node) {
    if (this === node) {
      return true;
    }

    return false;
  }

  cloneNode(deep) {
    if (isShadowRoot(this)) {
      throw DOMException.create(this._globalObject, ["ShadowRoot nodes are not clonable.", "NotSupportedError"]);
    }

    deep = Boolean(deep);

    return clone(this, undefined, deep);
  }

  get nodeValue() {
    switch (this.nodeType) {
      case NODE_TYPE.ATTRIBUTE_NODE: {
        return this._value;
      }
      case NODE_TYPE.TEXT_NODE:
      case NODE_TYPE.CDATA_SECTION_NODE: // CDATASection is a subclass of Text
      case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      case NODE_TYPE.COMMENT_NODE: {
        return this._data;
      }
      default: {
        return null;
      }
    }
  }

  set nodeValue(value) {
    if (value === null) {
      value = "";
    }

    switch (this.nodeType) {
      case NODE_TYPE.ATTRIBUTE_NODE: {
        setAnExistingAttributeValue(this, value);
        break;
      }
      case NODE_TYPE.TEXT_NODE:
      case NODE_TYPE.CDATA_SECTION_NODE: // CDATASection is a subclass of Text
      case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      case NODE_TYPE.COMMENT_NODE: {
        this.replaceData(0, this.length, value);
        break;
      }
    }
  }

  // https://dom.spec.whatwg.org/#dom-node-textcontent
  get textContent() {
    switch (this.nodeType) {
      case NODE_TYPE.DOCUMENT_FRAGMENT_NODE:
      case NODE_TYPE.ELEMENT_NODE: {
        // The descendant text content: concatenate the data of Text (and CDATASection) descendants in tree order,
        // walking the tree links directly.
        let node = this._links?.firstChild ?? null;
        let text = "";
        while (node !== null) {
          const { nodeType } = node;
          if (nodeType === NODE_TYPE.TEXT_NODE || nodeType === NODE_TYPE.CDATA_SECTION_NODE) {
            text += node._data;
          }
          let links = node._links;
          if (links.firstChild !== null) {
            node = links.firstChild;
            continue;
          }
          while (links.nextSibling === null) {
            node = links.parent;
            if (node === this) {
              return text;
            }
            links = node._links;
          }
          node = links.nextSibling;
        }
        return text;
      }

      case NODE_TYPE.ATTRIBUTE_NODE: {
        return this._value;
      }

      case NODE_TYPE.TEXT_NODE:
      case NODE_TYPE.CDATA_SECTION_NODE: // CDATASection is a subclass of Text
      case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      case NODE_TYPE.COMMENT_NODE: {
        return this._data;
      }

      default: {
        return null;
      }
    }
  }
  set textContent(value) {
    if (value === null) {
      value = "";
    }

    switch (this.nodeType) {
      case NODE_TYPE.DOCUMENT_FRAGMENT_NODE:
      case NODE_TYPE.ELEMENT_NODE: {
        // https://dom.spec.whatwg.org/#string-replace-all
        let nodeImpl = null;

        if (value !== "") {
          nodeImpl = this._ownerDocument.createTextNode(value);
        }

        this._replaceAll(nodeImpl);
        break;
      }

      case NODE_TYPE.ATTRIBUTE_NODE: {
        setAnExistingAttributeValue(this, value);
        break;
      }

      case NODE_TYPE.TEXT_NODE:
      case NODE_TYPE.CDATA_SECTION_NODE: // CDATASection is a subclass of Text
      case NODE_TYPE.PROCESSING_INSTRUCTION_NODE:
      case NODE_TYPE.COMMENT_NODE: {
        this.replaceData(0, this.length, value);
        break;
      }
    }
  }

  // https://dom.spec.whatwg.org/#dom-node-insertbefore
  insertBefore(nodeImpl, childImpl) {
    return this._preInsert(nodeImpl, childImpl);
  }

  // https://dom.spec.whatwg.org/#dom-node-appendchild
  appendChild(nodeImpl) {
    return this._append(nodeImpl);
  }

  // https://dom.spec.whatwg.org/#dom-node-replacechild
  replaceChild(nodeImpl, childImpl) {
    return this._replace(nodeImpl, childImpl);
  }

  // https://dom.spec.whatwg.org/#dom-node-removechild
  removeChild(oldChildImpl) {
    return this._preRemove(oldChildImpl);
  }

  // https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity
  _preInsertValidity(nodeImpl, childImpl, childrenToExclude = EMPTY_SET) {
    const { nodeType } = nodeImpl;
    const parentType = this.nodeType;

    if (
      parentType !== NODE_TYPE.DOCUMENT_NODE &&
      parentType !== NODE_TYPE.DOCUMENT_FRAGMENT_NODE &&
      parentType !== NODE_TYPE.ELEMENT_NODE
    ) {
      throw DOMException.create(this._globalObject, [
        `Node can't be inserted in a ${this.nodeName} parent.`,
        "HierarchyRequestError"
      ]);
    }

    if (isHostInclusiveAncestor(nodeImpl, this)) {
      throw DOMException.create(this._globalObject, [
        "The operation would yield an incorrect node tree.",
        "HierarchyRequestError"
      ]);
    }

    if (childImpl && childImpl.parentNode !== this) {
      throw DOMException.create(this._globalObject, [
        "The child can not be found in the parent.",
        "NotFoundError"
      ]);
    }

    if (
      nodeType !== NODE_TYPE.DOCUMENT_FRAGMENT_NODE &&
      nodeType !== NODE_TYPE.DOCUMENT_TYPE_NODE &&
      nodeType !== NODE_TYPE.ELEMENT_NODE &&
      nodeType !== NODE_TYPE.TEXT_NODE &&
      nodeType !== NODE_TYPE.CDATA_SECTION_NODE && // CData section extends from Text
      nodeType !== NODE_TYPE.PROCESSING_INSTRUCTION_NODE &&
      nodeType !== NODE_TYPE.COMMENT_NODE
    ) {
      throw DOMException.create(this._globalObject, [
        `${nodeImpl.nodeName} node can't be inserted in parent node.`,
        "HierarchyRequestError"
      ]);
    }

    if (parentType !== NODE_TYPE.DOCUMENT_NODE) {
      if (nodeType === NODE_TYPE.DOCUMENT_TYPE_NODE) {
        throw DOMException.create(this._globalObject, [
          `${nodeImpl.nodeName} node can't be inserted in ${this.nodeName} parent.`,
          "HierarchyRequestError"
        ]);
      }

      return;
    }

    if (nodeType === NODE_TYPE.TEXT_NODE || nodeType === NODE_TYPE.CDATA_SECTION_NODE) {
      throw DOMException.create(this._globalObject, [
        `${nodeImpl.nodeName} node can't be inserted in ${this.nodeName} parent.`,
        "HierarchyRequestError"
      ]);
    }

    if (
      nodeType === NODE_TYPE.PROCESSING_INSTRUCTION_NODE ||
      nodeType === NODE_TYPE.COMMENT_NODE
    ) {
      return;
    }

    if (nodeType === NODE_TYPE.DOCUMENT_FRAGMENT_NODE) {
      let hasElementChild = false;

      for (const child of nodeImpl._children()) {
        if (
          (hasElementChild && child.nodeType === NODE_TYPE.ELEMENT_NODE) ||
          child.nodeType === NODE_TYPE.TEXT_NODE ||
          child.nodeType === NODE_TYPE.CDATA_SECTION_NODE
        ) {
          throw DOMException.create(this._globalObject, [
            `Invalid insertion of ${nodeImpl.nodeName} node in ${this.nodeName} node.`,
            "HierarchyRequestError"
          ]);
        }

        if (child.nodeType === NODE_TYPE.ELEMENT_NODE) {
          hasElementChild = true;
        }
      }

      if (!hasElementChild) {
        return;
      }
    }

    if (nodeType === NODE_TYPE.DOCUMENT_FRAGMENT_NODE || nodeType === NODE_TYPE.ELEMENT_NODE) {
      let isFollowingChild = false;

      for (const child of this._children()) {
        const isChild = child === childImpl;

        if (
          (child.nodeType === NODE_TYPE.ELEMENT_NODE && !childrenToExclude.has(child)) ||
          (
            child.nodeType === NODE_TYPE.DOCUMENT_TYPE_NODE &&
            (isFollowingChild || (isChild && !childrenToExclude.has(child)))
          )
        ) {
          throw DOMException.create(this._globalObject, [
            `Invalid insertion of ${nodeImpl.nodeName} node in ${this.nodeName} node.`,
            "HierarchyRequestError"
          ]);
        }

        if (isChild) {
          isFollowingChild = true;
        }
      }

      return;
    }

    let isPrecedingChild = childImpl !== null;

    for (const child of this._children()) {
      if (child === childImpl) {
        isPrecedingChild = false;
      }

      if (
        (child.nodeType === NODE_TYPE.DOCUMENT_TYPE_NODE && !childrenToExclude.has(child)) ||
        (
          child.nodeType === NODE_TYPE.ELEMENT_NODE &&
          (isPrecedingChild || (childImpl === null && !childrenToExclude.has(child)))
        )
      ) {
        throw DOMException.create(this._globalObject, [
          `Invalid insertion of ${nodeImpl.nodeName} node in ${this.nodeName} node.`,
          "HierarchyRequestError"
        ]);
      }
    }
  }

  // https://dom.spec.whatwg.org/#concept-node-pre-insert
  _preInsert(nodeImpl, childImpl) {
    this._preInsertValidity(nodeImpl, childImpl);

    let referenceChildImpl = childImpl;
    if (referenceChildImpl === nodeImpl) {
      referenceChildImpl = nodeImpl.nextSibling;
    }

    this._insert(nodeImpl, referenceChildImpl);

    return nodeImpl;
  }

  // https://dom.spec.whatwg.org/#concept-node-insert
  _insert(nodeImpl, childImpl, suppressObservers = false) {
    let nodesImpl, postConnectionNodes;

    if (nodeImpl.nodeType === NODE_TYPE.DOCUMENT_FRAGMENT_NODE) {
      nodesImpl = [];

      for (const child of nodeImpl._children()) {
        nodesImpl.push(child);
        nodeImpl._remove(child, true);
      }

      if (nodesImpl.length === 0) {
        return nodesImpl;
      }

      queueTreeMutationRecord(nodeImpl, [], nodesImpl, null, null);
    } else {
      nodesImpl = [nodeImpl];
    }

    const count = nodesImpl.length;

    if (childImpl !== null && this._referencedRanges !== null) {
      let childIndex;

      for (const range of this._liveRanges()) {
        childIndex ??= childImpl._treeIndex();
        const { _start, _end } = range;

        if (_start.node === this && _start.offset > childIndex) {
          range._setLiveRangeStart(this, _start.offset + count);
        }

        if (_end.node === this && _end.offset > childIndex) {
          range._setLiveRangeEnd(this, _end.offset + count);
        }
      }
    }

    const previousChildImpl = childImpl ?
      childImpl.previousSibling :
      this.lastChild;

    // Whether every node went through `connectSubtree()` without running insertion steps, in which case the
    // post-connection nodes it collected are the ones the walk below would find, provided the children changed steps
    // run in between are the default ones (which cannot change the tree).
    let fusedWalk = true;
    const ownerDocument = this._ownerDocument;
    for (const node of nodesImpl) {
      // A subtree moved within the connected tree whose disconnecting and reconnecting would have no effect stays
      // connected: `_remove()` skips `disconnectSubtree()` for it, and it skips `connectSubtree()` below.
      let staysConnected = false;
      if (node._ownerDocument !== ownerDocument || node.parentNode !== null) {
        if (!fastPathFlags.shadowRoots && this._isInDocumentTree && node._isInDocumentTree &&
            node._ownerDocument === ownerDocument && canMoveConnected(node)) {
          staysConnected = true;
          keepConnectedNode = node;
        }
        ownerDocument._adoptNode(node);
        keepConnectedNode = null;
      }

      if (childImpl === null) {
        treeHelpers.appendChild(this, node);
      } else {
        treeHelpers.insertBefore(childImpl, node);
      }

      // Without any shadow roots, slots never have assigned nodes and every root is a light-tree root.
      const { shadowRoots } = fastPathFlags;
      if (
        shadowRoots &&
        (this.nodeType === NODE_TYPE.ELEMENT_NODE && this._shadowRoot !== null) &&
        (node.nodeType === NODE_TYPE.ELEMENT_NODE || node.nodeType === NODE_TYPE.TEXT_NODE)
      ) {
        assignSlot(node);
      }

      this._invalidateCaches(mutationJournal.INSERT, node);

      if (shadowRoots) {
        if (isSlot(this) && this._assignedNodes.length === 0 && isShadowRoot(this.getRootNode())) {
          signalSlotChange(this);
        }

        const root = node.getRootNode();
        if (isShadowRoot(root)) {
          assignSlotableForTree(root);
        }
      }

      if (staysConnected) {
        continue;
      }
      if (!shadowRoots && this._isInDocumentTree) {
        connectRanInsertionSteps = false;
        postConnectionNodes = connectSubtree(node, this, postConnectionNodes);
        fusedWalk &&= !connectRanInsertionSteps;
        continue;
      }
      fusedWalk = false;

      if (this._isInDocumentTree) {
        addSubtreeToDocumentCaches(node);
      }

      updateRadioButtonGroupsForTreeChange(node, this);

      if (fastPathFlags.shadowRoots) {
        for (const inclusiveDescendant of node._shadowIncludingInclusiveDescendants()) {
          runInsertionStepsFor(inclusiveDescendant);
        }
      } else if (!this._isInDocumentTree) {
        // Without shadow trees, nothing in a subtree inserted into a disconnected parent becomes connected, so the
        // connected custom element steps and the connected-only insertion steps (input, style, link) do nothing, and
        // base only clears a cache. That leaves option's "update nearest ancestor select", which looks at its parent
        // and grandparent only, so it can change only for `node` and its children. Skipping the rest of the subtree
        // keeps building a detached tree bottom-up (as React does) from walking each subtree once per ancestor.
        runInsertionStepsFor(node);
        for (let child = node._links.firstChild; child !== null; child = child._links.nextSibling) {
          runInsertionStepsFor(child);
        }
      } else {
        // Same traversal as the shadow-including iterator when there are no shadow trees: the next node is
        // captured before visiting the current one.
        let next = node;
        while (next !== null) {
          const inclusiveDescendant = next;
          next = treeHelpers.nextInTree(inclusiveDescendant, node);
          runInsertionStepsFor(inclusiveDescendant);
        }
      }
    }

    if (!suppressObservers) {
      queueTreeMutationRecord(this, nodesImpl, [], previousChildImpl, childImpl);
    }

    this._childrenInsertedSteps();

    if (fusedWalk && this._childrenInsertedSteps === NodeImpl.prototype._childrenInsertedSteps &&
        this._childrenChangedSteps === NodeImpl.prototype._childrenChangedSteps) {
      if (postConnectionNodes) {
        for (const node of postConnectionNodes) {
          if (node.isConnected) {
            node._postConnectionSteps();
          }
        }
      }
      return nodesImpl;
    }
    postConnectionNodes = undefined;

    // Post-connection steps only run for connected nodes, and without shadow trees none are when the parent is not.
    for (const node of fastPathFlags.shadowRoots || this._isInDocumentTree ? nodesImpl : EMPTY_ARRAY) {
      if (fastPathFlags.shadowRoots) {
        for (const inclusiveDescendant of node._shadowIncludingInclusiveDescendants()) {
          if (inclusiveDescendant._postConnectionSteps) {
            postConnectionNodes ||= [];
            postConnectionNodes.push(inclusiveDescendant);
          }
        }
      } else {
        for (let inclusiveDescendant = node; inclusiveDescendant !== null;
          inclusiveDescendant = treeHelpers.nextInTree(inclusiveDescendant, node)) {
          if (inclusiveDescendant._postConnectionSteps) {
            postConnectionNodes ||= [];
            postConnectionNodes.push(inclusiveDescendant);
          }
        }
      }
    }

    if (postConnectionNodes) {
      for (const node of postConnectionNodes) {
        if (node.isConnected) {
          node._postConnectionSteps();
        }
      }
    }

    return nodesImpl;
  }

  // https://dom.spec.whatwg.org/#concept-node-append
  _append(nodeImpl) {
    return this._preInsert(nodeImpl, null);
  }

  // https://dom.spec.whatwg.org/#concept-node-replace
  _replace(nodeImpl, childImpl) {
    this._preInsertValidity(nodeImpl, childImpl, new Set([childImpl]));

    let referenceChildImpl = childImpl.nextSibling;
    if (referenceChildImpl === nodeImpl) {
      referenceChildImpl = nodeImpl.nextSibling;
    }

    const previousSiblingImpl = childImpl.previousSibling;

    let removedNodesImpl = [];

    this._ownerDocument._adoptNode(nodeImpl);

    if (childImpl.parentNode) {
      removedNodesImpl = [childImpl];
      this._remove(childImpl, true);
    }

    const nodesImpl = this._insert(nodeImpl, referenceChildImpl, true);

    queueTreeMutationRecord(this, nodesImpl, removedNodesImpl, previousSiblingImpl, referenceChildImpl);

    return childImpl;
  }

  // https://dom.spec.whatwg.org/#concept-node-replace-all
  _replaceAll(nodeImpl) {
    const removedNodesImpl = this._childrenToArray();

    let addedNodesImpl;
    if (nodeImpl === null) {
      addedNodesImpl = [];
    } else if (nodeImpl.nodeType === NODE_TYPE.DOCUMENT_FRAGMENT_NODE) {
      addedNodesImpl = nodeImpl._childrenToArray();
    } else {
      addedNodesImpl = [nodeImpl];
    }

    for (const childImpl of removedNodesImpl) {
      this._remove(childImpl, true);
    }

    if (nodeImpl !== null) {
      this._insert(nodeImpl, null, true);
    }

    if (addedNodesImpl.length > 0 || removedNodesImpl.length > 0) {
      queueTreeMutationRecord(this, addedNodesImpl, removedNodesImpl, null, null);
    }
  }

  // https://dom.spec.whatwg.org/#concept-node-pre-remove
  _preRemove(childImpl) {
    if (childImpl.parentNode !== this) {
      throw DOMException.create(this._globalObject, [
        "The node to be removed is not a child of this node.",
        "NotFoundError"
      ]);
    }

    this._remove(childImpl);

    return childImpl;
  }

  // https://dom.spec.whatwg.org/#concept-node-remove
  _remove(nodeImpl, suppressObservers) {
    const wasParentConnected = this.isConnected;
    let index;
    let hasSlotDescendant = false;

    // Without shadow roots slots have no assigned nodes, and without ranges there is nothing to update, so the
    // descendant walk can be skipped entirely.
    const { shadowRoots } = fastPathFlags;
    for (
      let descendant = shadowRoots || fastPathFlags.ranges ? nodeImpl : null;
      descendant !== null;
      descendant = treeHelpers.nextInTree(descendant, nodeImpl)
    ) {
      if (shadowRoots && !hasSlotDescendant && isSlot(descendant)) {
        hasSlotDescendant = true;
      }

      if (descendant._referencedRanges === null) {
        continue;
      }

      for (const range of descendant._liveRanges()) {
        index ??= nodeImpl._treeIndex();
        const { _start, _end } = range;

        if (_start.node === descendant) {
          range._setLiveRangeStart(this, index);
        }

        if (_end.node === descendant) {
          range._setLiveRangeEnd(this, index);
        }
      }
    }

    for (const range of this._referencedRanges === null ? [] : this._liveRanges()) {
      index ??= nodeImpl._treeIndex();
      const { _start, _end } = range;

      if (_start.node === this && _start.offset > index) {
        range._setLiveRangeStart(this, _start.offset - 1);
      }

      if (_end.node === this && _end.offset > index) {
        range._setLiveRangeEnd(this, _end.offset - 1);
      }
    }

    const workingNodeIterators = this._ownerDocument._workingNodeIterators;
    if (workingNodeIterators._refSet.size !== 0) {
      for (const iterator of workingNodeIterators) {
        iterator._preRemoveSteps(nodeImpl);
      }
    }

    const oldPreviousSiblingImpl = nodeImpl.previousSibling;
    const oldNextSiblingImpl = nodeImpl.nextSibling;

    treeHelpers.remove(nodeImpl);
    nodeImpl._cachedRoot = null;
    // Without shadow trees, connected subtrees are exactly those in the document tree, and
    // `removeSubtreeFromDocumentCaches()` below clears their cached roots.
    if (wasParentConnected && (shadowRoots || !nodeImpl._isInDocumentTree)) {
      for (const descendantImpl of nodeImpl._shadowIncludingDescendants()) {
        descendantImpl._cachedRoot = null;
      }
    }

    if (nodeImpl._assignedSlot) {
      assignSlotable(nodeImpl._assignedSlot);
    }

    if (shadowRoots && isSlot(this) && this._assignedNodes.length === 0 && isShadowRoot(this.getRootNode())) {
      signalSlotChange(this);
    }

    if (hasSlotDescendant) {
      assignSlotableForTree(this.getRootNode());
      assignSlotableForTree(nodeImpl);
    }

    this._invalidateCaches(mutationJournal.REMOVE, nodeImpl);
    if (!shadowRoots && nodeImpl._isInDocumentTree) {
      if (keepConnectedNode === nodeImpl) {
        // Being moved by `_insert()`, which checked that the subtree has no checked inputs (no inputs at all).
        keepConnectedNode = null;
        if (!suppressObservers) {
          queueTreeMutationRecord(this, [], [nodeImpl], oldPreviousSiblingImpl, oldNextSiblingImpl);
        }
        this._childrenChangedSteps();
        return;
      }
      disconnectSubtree(nodeImpl, this);
      this._finishRemove(nodeImpl, suppressObservers, oldPreviousSiblingImpl, oldNextSiblingImpl);
      return;
    }
    if (nodeImpl._isInDocumentTree) {
      removeSubtreeFromDocumentCaches(nodeImpl);
    }

    nodeImpl._removingSteps(true, this);
    const isParentConnected = this.isConnected;
    if (nodeImpl._ceState === "custom" && isParentConnected) {
      enqueueCECallbackReaction(nodeImpl, "disconnectedCallback", []);
    }

    if (fastPathFlags.shadowRoots) {
      for (const descendantImpl of nodeImpl._shadowIncludingDescendants()) {
        descendantImpl._removingSteps(false, this);
        if (descendantImpl._ceState === "custom" && isParentConnected) {
          enqueueCECallbackReaction(descendantImpl, "disconnectedCallback", []);
        }
      }
    } else {
      // Same traversal as the shadow-including iterator when there are no shadow trees: the next node is captured
      // before visiting the current one.
      let next = treeHelpers.nextInTree(nodeImpl, nodeImpl);
      while (next !== null) {
        const descendantImpl = next;
        next = treeHelpers.nextInTree(descendantImpl, nodeImpl);
        descendantImpl._removingSteps(false, this);
        if (descendantImpl._ceState === "custom" && isParentConnected) {
          enqueueCECallbackReaction(descendantImpl, "disconnectedCallback", []);
        }
      }
    }

    this._finishRemove(nodeImpl, suppressObservers, oldPreviousSiblingImpl, oldNextSiblingImpl);
  }

  _finishRemove(nodeImpl, suppressObservers, oldPreviousSiblingImpl, oldNextSiblingImpl) {
    updateRadioButtonGroupsForTreeChange(nodeImpl, this);

    if (!suppressObservers) {
      queueTreeMutationRecord(this, [], [nodeImpl], oldPreviousSiblingImpl, oldNextSiblingImpl);
    }

    this._childrenChangedSteps();
  }
}

// Per-instance defaults for rarely written fields; instances get an own property on first write.
const baseRemovingSteps = NodeImpl.prototype._removingSteps;

treeHelpers.setLinkFlagsComputer(node => {
  let flags = 0;
  if (node._removingSteps !== baseRemovingSteps || node._insertionSteps || node._postConnectionSteps) {
    flags |= LINK_STEPS;
  }
  if (node.nodeType !== NODE_TYPE.ELEMENT_NODE) {
    return flags;
  }
  flags |= LINK_ELEMENT;
  if (node._ceState !== "uncustomized") {
    flags |= LINK_CUSTOM_ELEMENT;
  }
  const attributes = node._attributeList;
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    if (attr._namespace === null && (attr._localName === "id" || attr._localName === "name")) {
      flags |= LINK_ID_OR_NAME;
      break;
    }
  }
  return flags;
});
const baseChildrenChangedSteps = NodeImpl.prototype._childrenChangedSteps;

// Without shadow trees, inserting `root` into the connected `parent` in one tree walk: adds the subtree to the document
// caches, collects the checked inputs for the radio button group update, and enqueues the custom element reactions;
// then runs the radio button group update and the insertion steps that elements define (in tree order). The spec runs
// the per-node steps after all caches are updated and the radio button group update; doing the custom element part
// during the walk is equivalent because enqueued reactions are not observable before the insertion completes, and
// only the few element types with `_insertionSteps` have per-node steps that are.
//
// Also appends the subtree's nodes with post-connection steps to `postConnectionNodes` (an array or null), and returns
// it. That list is only valid as the spec's static node list if nothing observable ran in between, so this sets
// `connectRanInsertionSteps` when it ran any element's insertion steps.
function connectSubtree(root, parent, postConnectionNodes) {
  const document = root._ownerDocument;
  const tracker = windowProperties.trackerForDocument(document);
  let affectsNamedProperties = false;
  let stepNodes = null;
  let checkedInputs = null;

  // Every node in the subtree has links: the root has a parent, and the others have parents in the subtree.
  for (let node = root; node !== null;) {
    node._isInDocumentTree = true;
    const links = node._links;
    const { flags } = links;
    if (flags & LINK_ID_OR_NAME) {
      // Only the id and name attributes feed the caches.
      const attributes = node._attributeList;
      let id = null;
      let name = null;
      for (let i = 0; i < attributes.length; i++) {
        const attr = attributes[i];
        if (attr._namespace === null) {
          if (attr._localName === "id") {
            id = attr._value;
          } else if (attr._localName === "name") {
            name = attr._value;
          }
        }
      }
      if (id !== null || name !== null) {
        if (tracker !== undefined) {
          windowProperties.elementAttached(tracker, node, id);
        }
        if (id) {
          document._byIdCache.add(id, node);
        }
        affectsNamedProperties ||= isNamedPropertyElement(node) && (Boolean(id) || Boolean(name));
      }
    }
    if (flags & LINK_STEPS && flags & LINK_ELEMENT) {
      if (node._postConnectionSteps) {
        (postConnectionNodes ??= []).push(node);
      }
      if (node._insertionSteps) {
        (stepNodes ??= []).push(node);
        if (node._localName === "input" && node._checkedness && node._namespaceURI === HTML_NS) {
          (checkedInputs ??= []).push(node);
        }
      }
    }
    if (flags & LINK_CUSTOM_ELEMENT) {
      if (node._ceState === "custom") {
        enqueueCECallbackReaction(node, "connectedCallback", []);
      } else {
        tryUpgradeElement(node);
      }
    }
    node = links.firstChild ?? treeHelpers.nextAfterSubtree(node, root);
  }

  if (affectsNamedProperties) {
    document._clearNamedPropertyCache();
  }
  if (checkedInputs !== null) {
    updateRadioButtonGroupsForInsertedInputs(checkedInputs, parent);
  }
  if (stepNodes !== null) {
    connectRanInsertionSteps = true;
    for (const node of stepNodes) {
      node._insertionSteps();
    }
  }
  return postConnectionNodes;
}

// Without shadow trees, whether removing the connected `root` from its parent and inserting it elsewhere in the same
// document's tree can skip `disconnectSubtree()` and `connectSubtree()`: true when they would have no net effect.
// That needs no node with removing, insertion or post-connection steps (these include every input, so no radio button
// group changes either), no custom element or element that could be upgraded, no id or name attribute (the caches
// would only be reordered), the focused element outside the subtree, and default children changed steps for the old
// parent, which run while the subtree is detached.
function canMoveConnected(root) {
  if (root.parentNode._childrenChangedSteps !== baseChildrenChangedSteps) {
    return false;
  }
  const lastFocusedElement = root._ownerDocument._lastFocusedElement;
  for (let node = root; node !== null;) {
    const links = node._links;
    const { flags } = links;
    // Only elements have these steps, or can be focused.
    if (flags & LINK_ELEMENT) {
      if (flags & LINK_STEPS || node === lastFocusedElement ||
          (flags & LINK_CUSTOM_ELEMENT && (node._ceState === "custom" || node._ceState === "undefined"))) {
        return false;
      }
      if (flags & LINK_ID_OR_NAME) {
        const attributes = node._attributeList;
        for (let i = 0; i < attributes.length; i++) {
          const attr = attributes[i];
          if (attr._namespace === null && (attr._localName === "id" || attr._localName === "name")) {
            return false;
          }
        }
      }
    }
    node = links.firstChild ?? treeHelpers.nextAfterSubtree(node, root);
  }
  return true;
}

// Without shadow trees, removing the connected `root` from `parent` in one tree walk: removes the subtree from the
// document caches, runs the base removing steps (focus fixup) and collects the nodes with their own removing steps and
// the custom elements; then runs those removing steps and enqueues the disconnectedCallback reactions, in tree order.
// The spec updates all caches first and then visits each node; only the collected nodes' steps are observable.
function disconnectSubtree(root, parent) {
  const document = root._ownerDocument;
  const tracker = windowProperties.trackerForDocument(document);
  let stepNodes = null;
  let customElements = null;
  // Only this walk's own focus fixup changes it, and at most one node matches.
  const lastFocusedElement = document._lastFocusedElement;

  for (let node = root; node !== null;) {
    const links = node._links;
    const { flags } = links;
    node._isInDocumentTree = false;
    // The removed subtree's root is no longer the document. Skip the write when the prototype default is in effect,
    // which keeps from giving every removed node its own property.
    if (node._cachedRoot !== null) {
      node._cachedRoot = null;
    }
    if (flags & LINK_STEPS && node._removingSteps !== baseRemovingSteps) {
      (stepNodes ??= []).push(node);
    } else if (node === lastFocusedElement) {
      document._lastFocusedElement = document;
    }
    const current = node;
    node = links.firstChild ?? treeHelpers.nextAfterSubtree(node, root);
    if (!(flags & LINK_ELEMENT)) {
      continue;
    }
    if (flags & LINK_CUSTOM_ELEMENT && current._ceState === "custom") {
      (customElements ??= []).push(current);
    }
    if (!(flags & LINK_ID_OR_NAME)) {
      continue;
    }
    const attributes = current._attributeList;
    let id = null;
    let hasIdOrName = false;
    for (let i = 0; i < attributes.length; i++) {
      const attr = attributes[i];
      if (attr._namespace === null) {
        if (attr._localName === "id") {
          id = attr._value;
          hasIdOrName = true;
        } else if (attr._localName === "name") {
          hasIdOrName = true;
        }
      }
    }
    if (hasIdOrName) {
      if (isNamedPropertyElement(current)) {
        document._namedPropertyElementRemoved(current);
      }
      if (tracker !== undefined) {
        windowProperties.elementDetached(tracker, current, id);
      }
      if (id) {
        document._byIdCache.delete(id, current);
      }
    }
  }

  let i = 0;
  if (stepNodes !== null && stepNodes[0] === root) {
    root._removingSteps(true, parent);
    i = 1;
  }
  const isParentConnected = parent.isConnected;
  if (stepNodes !== null) {
    for (; i < stepNodes.length; i++) {
      stepNodes[i]._removingSteps(false, parent);
    }
  }
  if (customElements !== null && isParentConnected) {
    for (const node of customElements) {
      enqueueCECallbackReaction(node, "disconnectedCallback", []);
    }
  }
}

defineFieldDefaults(NodeImpl.prototype, {
  _childNodesList: null,
  _childrenList: null,
  _cachedRoot: null,
  // Most nodes are never observed, so allocate their registration lists lazily.
  _registeredObserverList: null,
  // Lazily-created Set of WeakRef<Range>
  _referencedRanges: null,
  _memoizedQueries: null
});

module.exports = {
  implementation: NodeImpl
};
