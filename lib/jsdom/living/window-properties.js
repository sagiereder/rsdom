"use strict";
const idlUtils = require("../../generated/idl/utils.js");
const HTMLCollection = require("../../generated/idl/HTMLCollection.js");
const { HTML_NS } = require("./helpers/namespaces.js");
const NODE_DOCUMENT_POSITION = require("./node-document-position");

// We count iframe/frame here too even though it's not in the relevant part of the spec because we still need to track
// named iframes/frames, and we'll process the element -> WindowProxy work as special cases.
const nameAttributeElementLocalNames = new Set(["embed", "form", "img", "object", "iframe", "frame"]);

// WeakMap<Window, Map<string, Element | Set<Element>>>. A window's tracker is only created the first time one of its
// named properties is looked up, by walking its document; from then on it is maintained incrementally. Until then,
// element attachment, detachment and id/name changes need no bookkeeping here.
const trackers = new WeakMap();

function getTracker(window) {
  let tracker = trackers.get(window);
  if (tracker === undefined) {
    tracker = new Map();
    trackers.set(window, tracker);
    const document = window._document;
    if (document) {
      for (const node of document._descendants()) {
        if (node.nodeType === 1 && node._namespaceURI === HTML_NS) {
          trackElement(tracker, node);
        }
      }
    }
  }
  return tracker;
}

function trackElement(tracker, element) {
  const idAttr = element.getAttributeNS(null, "id");
  const nameAttr = nameAttributeElementLocalNames.has(element._localName) ?
    element.getAttributeNS(null, "name") :
    null;

  if (nameAttr) {
    upsert(tracker, nameAttr, element);
  }

  if (idAttr) {
    upsert(tracker, idAttr, element);
  }
}

function entrySet(entry) {
  return entry instanceof Set ? entry : new Set([entry]);
}

function inAssociatedDocument(element) {
  const document = element._ownerDocument;
  return document._globalObject._document === document;
}

// Entries hold a single element directly, and a Set only once several elements share a name.
function upsert(map, key, value) {
  const entry = map.get(key);
  if (entry === undefined) {
    map.set(key, value);
  } else if (entry instanceof Set) {
    entry.add(value);
  } else if (entry !== value) {
    map.set(key, new Set([entry, value]));
  }
}

function remove(map, key, value) {
  const entry = map.get(key);
  if (entry === undefined) {
    return;
  }
  if (entry instanceof Set) {
    entry.delete(value);
    if (entry.size === 0) {
      map.delete(key);
    }
  } else if (entry === value) {
    map.delete(key);
  }
}

function treeOrderSorter(a, b) {
  const compare = a._compareTreePosition(b);

  if (compare & NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_PRECEDING) { // b is preceding a
    return 1;
  }

  if (compare & NODE_DOCUMENT_POSITION.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }

  // disconnected or equal:
  return 0;
}

function getNamedObject(window, name) {
  // Window setup assigns properties before the document exists; there is nothing to track yet.
  if (!window._document) {
    return undefined;
  }
  const tracker = getTracker(window);

  const entry = tracker.get(name);
  if (entry === undefined) {
    return undefined;
  }
  const set = entrySet(entry);

  const elements = set.size === 1 ? set : [...set].sort(treeOrderSorter);
  for (const element of elements) {
    if (element._localName === "iframe" || element._localName === "frame") {
      const { contentWindow } = element;
      if (contentWindow !== null && element.getAttributeNS(null, "name") === name) {
        return contentWindow;
      }
    }
  }

  if (set.size === 1) {
    return idlUtils.wrapperForImpl(set.values().next().value);
  }

  return HTMLCollection.create(window, [], {
    element: window._document,
    query() {
      // Do *not* reuse `elements` or `set` from above. We need to re-get and re-iterate the set each time because it
      // might have changed due to elements being attached, removed, or having their names changed!
      const currentEntry = getTracker(window).get(name);
      return currentEntry === undefined ? [] : [...entrySet(currentEntry)].sort(treeOrderSorter);
    }
  });
}

exports.elementAttached = element => {
  if (element._namespaceURI !== HTML_NS) {
    return;
  }

  const window = element._ownerDocument._globalObject;
  const tracker = trackers.get(window);
  if (tracker === undefined || !inAssociatedDocument(element)) {
    return;
  }

  trackElement(tracker, element);
};

exports.elementDetached = element => {
  if (element._namespaceURI !== HTML_NS) {
    return;
  }

  const window = element._ownerDocument._globalObject;
  const tracker = trackers.get(window);
  if (tracker === undefined || !inAssociatedDocument(element)) {
    return;
  }

  const idAttr = element.getAttributeNS(null, "id");
  const nameAttr = nameAttributeElementLocalNames.has(element._localName) ?
    element.getAttributeNS(null, "name") :
    null;

  if (idAttr) {
    remove(tracker, idAttr, element);
  }

  if (nameAttr) {
    remove(tracker, nameAttr, element);
  }
};

exports.elementAttributeModified = (element, attributeName, value, oldValue, namespace) => {
  const isIdAttribute = namespace === null && attributeName === "id";
  const isNameAttribute = namespace === null && attributeName === "name" &&
    nameAttributeElementLocalNames.has(element._localName);
  if ((!isIdAttribute && !isNameAttribute) || value === oldValue) {
    return;
  }

  // Window and Document named properties share this filtered mutation path, but have different contributors.
  element._ownerDocument._namedPropertyElementAttributeModified(element, attributeName, value, oldValue);

  if (element._namespaceURI !== HTML_NS) {
    return;
  }

  const window = element._ownerDocument._globalObject;
  if (!inAssociatedDocument(element)) {
    return;
  }

  if (!element._isInDocumentTree) {
    return;
  }

  const tracker = trackers.get(window);
  if (tracker === undefined) {
    return;
  }

  if (isIdAttribute) {
    const nameAttr = nameAttributeElementLocalNames.has(element._localName) ?
      element.getAttributeNS(null, "name") :
      null;
    if (oldValue && nameAttr !== oldValue) {
      remove(tracker, oldValue, element);
    }
    if (value) {
      upsert(tracker, value, element);
    }
  } else {
    const idAttr = element.getAttributeNS(null, "id");
    if (oldValue && idAttr !== oldValue) {
      remove(tracker, oldValue, element);
    }
    if (value) {
      upsert(tracker, value, element);
    }
  }
};

exports.create = (eventTargetPrototype, window) => {
  const windowProperties = Object.create(eventTargetPrototype, {
    [Symbol.toStringTag]: {
      value: "WindowProperties",
      configurable: true
    }
  });

  const windowPropertiesProxy = new Proxy(windowProperties, {
    getOwnPropertyDescriptor(target, property) {
      if (typeof property === "symbol") {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }

      // Named property visibility algorithm check, modified as discused in
      // https://github.com/whatwg/webidl/issues/607.
      let targetObj = Object.getPrototypeOf(target);
      while (targetObj !== null) {
        if (Object.hasOwn(targetObj, property)) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }

        targetObj = Object.getPrototypeOf(targetObj);
      }

      const value = getNamedObject(window, property);
      if (value) {
        return {
          value,
          enumerable: false, // Window is [LegacyUnenumerableNamedProperties]
          writable: true,
          configurable: true
        };
      }

      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    has(target, property) {
      if (typeof property === "symbol") {
        return Reflect.has(target, property);
      }

      const desc = this.getOwnPropertyDescriptor(target, property);
      if (desc !== undefined) {
        return true;
      }

      const parent = Object.getPrototypeOf(target);
      return Reflect.has(parent, property);
    },
    get(target, property, receiver) {
      if (typeof property === "symbol") {
        return Reflect.get(target, property, receiver);
      }

      const desc = this.getOwnPropertyDescriptor(target, property);
      if (desc === undefined) {
        const parent = Object.getPrototypeOf(target);
        return Reflect.get(parent, property, receiver);
      }

      // Named properties object only has data properties.
      return desc.value;
    },
    set(target, property, value, receiver) {
      if (typeof property === "symbol") {
        return Reflect.set(target, property, value, receiver);
      }

      const ownDesc = this.getOwnPropertyDescriptor(target, property);
      return idlUtils.ordinarySetWithOwnDescriptor(target, property, value, receiver, ownDesc);
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    setPrototypeOf() {
      throw new TypeError("Immutable prototype object WindowProperties cannot have its prototype set.");
    },
    preventExtensions() {
      return false;
    }
  });

  return windowPropertiesProxy;
};
