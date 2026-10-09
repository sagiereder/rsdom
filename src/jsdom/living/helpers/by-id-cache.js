"use strict";

const NODE_TYPE = require("../node-type");
const { nextInTree } = require("./dom-tree");

// The first element in tree order among `start` and the following nodes within `root`'s subtree whose ID is `id`.
function findElementById(root, start, id) {
  for (let node = start; node !== null; node = nextInTree(node, root)) {
    if (node.nodeType === NODE_TYPE.ELEMENT_NODE) {
      const list = node._attributeList;
      for (let i = 0; i < list.length; i++) {
        const attr = list[i];
        if (attr._localName === "id" && attr._namespace === null) {
          if (attr._value === id) {
            return node;
          }
          break;
        }
      }
    }
  }
  return null;
}

// For use in implementing getElementById(). Notably it ensures that when you get the result, you will always get the
// first in tree order, not the most- or least-recently-inserted. Somewhat modeled after
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/dom/tree_ordered_map.h.

class ByIdCache {
  constructor(root) {
    this._root = root;

    // Keys are IDs (strings).
    // Values are `{ element, count }` tuples, where `element` can be `null` indicating we need to recompute.
    // `count` tracks the count of times `add()` was called for this ID. We need to track it because it lets us
    // determine what to do when calling `delete()`: a count of 0 means we can remove the entry, whereas any other
    // count means we need to set `element` to `null` for future recomputation.
    this._map = new Map();
  }

  add(id, element) {
    const value = this._map.get(id);
    if (!value) {
      this._map.set(id, { element, count: 1 });
    } else {
      value.element = null;
      ++value.count;
    }
  }

  delete(id, element) {
    const value = this._map.get(id);
    if (!value) {
      return;
    }

    --value.count;
    if (value.count === 0) {
      this._map.delete(id);
    } else if (value.element === element) {
      value.element = null;
    }
  }

  get(id) {
    const value = this._map.get(id);
    if (!value) {
      return null;
    }

    if (value.element) {
      return value.element;
    }

    const element = findElementById(this._root, this._root, id);
    if (element !== null) {
      value.element = element;
      return element;
    }

    // If we didn't find any elements for this key, we can remove it.
    this._map.delete(id);
    return null;
  }
}

module.exports = ByIdCache;
module.exports.findElementById = findElementById;
