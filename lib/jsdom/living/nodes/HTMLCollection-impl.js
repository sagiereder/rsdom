"use strict";

const idlUtils = require("../../../generated/idl/utils.js");
const { HTML_NS } = require("../helpers/namespaces");
const { compareTreePosition, nextInTree, observeVersion } = require("../helpers/dom-tree");
const { MutationJournal, INSERT, REMOVE, ATTRIBUTE } = require("../helpers/mutation-journal");
const NODE_DOCUMENT_POSITION = require("../node-document-position");

const ELEMENT_NODE = 1;
// Merging more elements than this one by one is slower than re-running the query.
const MAX_MERGE = 64;

function isInclusiveAncestor(ancestor, node) {
  for (let n = node; n !== null; n = n.parentNode) {
    if (n === ancestor) {
      return true;
    }
  }
  return false;
}

// Whether an element of the old list stays in it: it must still be under the root (only in doubt after removals) and
// not be dirty. Without removals, inserted subtrees contain no old elements.
function keepElement(el, root, hasRemovals, dirtyTrees, dirtyElements) {
  if (dirtyElements !== null && dirtyElements.has(el)) {
    return false;
  }
  if (!hasRemovals) {
    return true;
  }
  for (let n = el; n !== null; n = n.parentNode) {
    if (n === root) {
      return true;
    }
    if (dirtyTrees !== null && dirtyTrees.has(n)) {
      return false;
    }
  }
  return false;
}

// Whether `node` or one of its ancestors below `root` is in `dirtyTrees`.
function insideDirtyTree(node, root, dirtyTrees) {
  if (dirtyTrees === null) {
    return false;
  }
  for (let n = node; n !== null && n !== root; n = n.parentNode) {
    if (dirtyTrees.has(n)) {
      return true;
    }
  }
  return false;
}

function collectMatches(node, matcher, out) {
  for (let n = node; n !== null; n = nextInTree(n, node)) {
    if (n.nodeType === ELEMENT_NODE && matcher(n)) {
      out.push(n);
    }
  }
}

function precedes(a, b) {
  return (compareTreePosition(a, b) & NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// Inserts `added` (distinct elements not in `list`) into `list`, keeping tree order.
function mergeInTreeOrder(list, added) {
  if (added.length > MAX_MERGE) {
    return false;
  }
  if (added.length > 1) {
    added.sort((a, b) => {
      return precedes(a, b) ? -1 : 1;
    });
  }
  // Common case: everything was appended after the current last element.
  if (list.length === 0 || precedes(list[list.length - 1], added[0])) {
    for (const el of added) {
      list.push(el);
    }
    return true;
  }
  for (const el of added) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (precedes(list[mid], el)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    list.splice(lo, 0, el);
  }
  return true;
}

exports.implementation = class HTMLCollectionImpl {
  constructor(globalObject, args, privateData) {
    this._list = [];
    this._version = -1;
    this._element = privateData.element;
    observeVersion(this._element);
    this._query = privateData.query;
    // Optional: returns a predicate deciding membership of a descendant element. Collections with one can be updated
    // incrementally from the document's mutation journal.
    this._createMatcher = privateData.createMatcher ?? null;
    // The only attribute (in the null namespace) that membership depends on, if any.
    this._attributeName = privateData.attributeName ?? null;
    // Optional: returns a value that changes whenever the matcher's behavior does (e.g. the document's quirks mode).
    this._getMatcherMode = privateData.getMatcherMode ?? null;
    this._matcherMode = undefined;
    this._journal = null;
    this._seq = 0;

    this._globalObject = globalObject;

    this._update();
  }
  get length() {
    this._update();
    return this._list.length;
  }
  item(index) {
    this._update();
    return this._list[index] || null;
  }
  namedItem(key) {
    if (key === "") {
      return null;
    }
    this._update();
    for (const element of this._list) {
      if (element.getAttributeNS(null, "id") === key) {
        return element;
      }
      if (element._namespaceURI === HTML_NS) {
        const name = element.getAttributeNS(null, "name");
        if (name === key) {
          return element;
        }
      }
    }
    return null;
  }
  _invalidate() {
    // Drop stale nodes without rebuilding the collection so removed subtrees can be collected.
    this._list.length = 0;
    this._version = -1;
    this._journal = null;
  }
  _update() {
    const root = this._element;
    if (this._version >= root._version) {
      return;
    }
    if (this._createMatcher !== null) {
      const journal = root._ownerDocument._mutationJournal;
      if (journal !== null && journal === this._journal && this._seq >= journal.base &&
          (this._getMatcherMode === null || this._getMatcherMode() === this._matcherMode) &&
          this._applyJournal(journal)) {
        this._version = root._version;
        this._seq = journal.seq;
        return;
      }
    }
    const snapshot = this._query();
    for (let i = 0; i < snapshot.length; i++) {
      this._list[i] = snapshot[i];
    }
    this._list.length = snapshot.length;
    this._version = root._version;
    if (this._createMatcher !== null) {
      const doc = root._ownerDocument;
      doc._mutationJournal ??= new MutationJournal();
      this._journal = doc._mutationJournal;
      this._seq = this._journal.seq;
      this._matcherMode = this._getMatcherMode?.();
    }
  }

  // Brings `_list` up to date from the journal records since `_seq`. Returns false when a full rebuild is needed.
  //
  // The result must be the descendants of the root that currently match, in tree order. An element whose membership
  // changed since the last update either had the relevant attribute changed (an ATTRIBUTE record), or now sits under
  // the root by way of a node inserted since (an INSERT record for that node or one of its ancestors), or no longer
  // sits under the root, which requires a removal from a node that is still under the root (a REMOVE record). Without
  // relevant removals nothing was moved, so inserted subtrees hold no element of the old list, and old elements keep
  // their relative order.
  _applyJournal(journal) {
    const root = this._element;
    const { kinds, targets, nodes, names } = journal;
    const end = kinds.length;
    let hasRemovals = false;
    // Inserted nodes, whose whole subtrees need examining, and elements whose relevant attribute changed.
    let dirtyTrees = null;
    let dirtyElements = null;
    for (let i = this._seq - journal.base; i < end; i++) {
      const kind = kinds[i];
      if (kind === INSERT) {
        const node = nodes[i];
        if (node !== root && isInclusiveAncestor(root, node)) {
          (dirtyTrees ??= new Set()).add(node);
        }
      } else if (kind === ATTRIBUTE) {
        const target = targets[i];
        if (this._attributeName !== null && names[i] === this._attributeName && target !== root &&
            isInclusiveAncestor(root, target)) {
          (dirtyElements ??= new Set()).add(target);
        }
      } else if (kind === REMOVE) {
        hasRemovals ||= isInclusiveAncestor(root, targets[i]);
      } else if (isInclusiveAncestor(root, targets[i])) {
        return false;
      }
    }

    let list = this._list;
    if (hasRemovals || dirtyElements !== null) {
      // Keep old elements that are still under the root and not dirty; dirty ones are re-examined below.
      list = [];
      for (const el of this._list) {
        if (keepElement(el, root, hasRemovals, dirtyTrees, dirtyElements)) {
          list.push(el);
        }
      }
    }

    if (dirtyTrees !== null || dirtyElements !== null) {
      const matcher = this._createMatcher();
      const added = [];
      if (dirtyTrees !== null) {
        for (const node of dirtyTrees) {
          if (!insideDirtyTree(node.parentNode, root, dirtyTrees)) {
            collectMatches(node, matcher, added);
            if (added.length > MAX_MERGE) {
              return false;
            }
          }
        }
      }
      if (dirtyElements !== null) {
        for (const el of dirtyElements) {
          if (!insideDirtyTree(el, root, dirtyTrees) && matcher(el)) {
            added.push(el);
          }
        }
      }
      if (added.length > 0 && !mergeInTreeOrder(list, added)) {
        return false;
      }
    }

    if (list !== this._list) {
      for (let i = 0; i < list.length; i++) {
        this._list[i] = list[i];
      }
      this._list.length = list.length;
    }
    return true;
  }
  get [idlUtils.supportedPropertyIndices]() {
    this._update();
    return this._list.keys();
  }
  get [idlUtils.supportedPropertyNames]() {
    this._update();
    const result = new Set();
    for (const element of this._list) {
      const id = element.getAttributeNS(null, "id");
      if (id) {
        result.add(id);
      }
      if (element._namespaceURI === HTML_NS) {
        const name = element.getAttributeNS(null, "name");
        if (name) {
          result.add(name);
        }
      }
    }
    return result;
  }

  // Inherit some useful functions from Array.
  [Symbol.iterator]() {
    this._update();
    return this._list[Symbol.iterator]();
  }
  entries() {
    this._update();
    return this._list.entries();
  }
  filter(...args) {
    this._update();
    return this._list.filter(...args);
  }
  map(...args) {
    this._update();
    return this._list.map(...args);
  }
  indexOf(...args) {
    this._update();
    return this._list.indexOf(...args);
  }
};
