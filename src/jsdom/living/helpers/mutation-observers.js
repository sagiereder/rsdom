"use strict";

const reportException = require("./runtime-script-errors");
const fastPathFlags = require("./fast-path-flags");
const { ensureLinks, LINK_REGISTERED_OBSERVERS } = require("./dom-tree");

const Event = require("../../../generated/idl/Event");
const idlUtils = require("../../../generated/idl/utils");
const MutationRecord = require("../../../generated/idl/MutationRecord");

const MUTATION_TYPE = {
  ATTRIBUTES: "attributes",
  CHARACTER_DATA: "characterData",
  CHILD_LIST: "childList"
};

// Note:
// Since jsdom doesn't currently implement the concept of "unit of related similar-origin browsing contexts"
// (https://html.spec.whatwg.org/multipage/browsers.html#unit-of-related-similar-origin-browsing-contexts)
// we will approximate that the following properties are global for now.

// https://dom.spec.whatwg.org/#mutation-observer-compound-microtask-queued-flag
let mutationObserverMicrotaskQueueFlag = false;

// Non-spec compliant: List of all the mutation observers with mutation records enqueued. It's a replacement for
// mutation observer list (https://dom.spec.whatwg.org/#mutation-observer-list) but without leaking since it's empty
// before notifying the mutation observers.
const activeMutationObservers = new Set();

// Number of registered observers on all nodes (in all documents). Registrations of garbage-collected nodes are never
// subtracted, so this is an upper bound. When it is zero, no mutation can have an interested observer, so queueing a
// mutation record does not need to look for registered observers on the target's inclusive ancestors.
let registeredObserverCount = 0;

// Number of transient registered observers (those with a `source`) on all nodes, with the same upper-bound caveat.
// When it is zero, notifying observers has no transient registered observers to remove.
let transientObserverCount = 0;

// Bits for the mutation types, so that the interested-observers walk tests a registered observer's options with one
// mask instead of several option lookups and string comparisons.
const ATTRIBUTES_BIT = 1;
const CHARACTER_DATA_BIT = 2;
const CHILD_LIST_BIT = 4;

function typeBit(type) {
  switch (type) {
    case MUTATION_TYPE.ATTRIBUTES:
      return ATTRIBUTES_BIT;
    case MUTATION_TYPE.CHARACTER_DATA:
      return CHARACTER_DATA_BIT;
    default:
      return CHILD_LIST_BIT;
  }
}

// Sets a registered observer's options, along with the summary of them that queueMutationRecord() reads. Every write of
// `options` goes through here.
function setRegisteredObserverOptions(registeredObserver, options) {
  registeredObserver.options = options;
  registeredObserver.subtree = options.subtree === true;
  registeredObserver.types =
    (options.attributes === true ? ATTRIBUTES_BIT : 0) |
    (options.characterData === true ? CHARACTER_DATA_BIT : 0) |
    (options.childList === true ? CHILD_LIST_BIT : 0);
  registeredObserver.oldValueTypes =
    (options.attributeOldValue === true ? ATTRIBUTES_BIT : 0) |
    (options.characterDataOldValue === true ? CHARACTER_DATA_BIT : 0);
  registeredObserver.attributeFilter = options.attributeFilter ?? null;
}

function addRegisteredObserver(node, registeredObserver) {
  fastPathFlags.noteRegisteredObserver(node);
  ensureLinks(node).flags |= LINK_REGISTERED_OBSERVERS;
  if (node._registeredObserverList === null) {
    node._registeredObserverList = [registeredObserver];
  } else {
    node._registeredObserverList.push(registeredObserver);
  }
  registeredObserverCount++;
  if (registeredObserver.source !== undefined) {
    transientObserverCount++;
  }
}

function filterRegisteredObservers(node, predicate) {
  const list = node._registeredObserverList;
  if (list === null) {
    return;
  }
  const filtered = [];
  for (const registeredObserver of list) {
    if (predicate(registeredObserver)) {
      filtered.push(registeredObserver);
    } else {
      registeredObserverCount--;
      if (registeredObserver.source !== undefined) {
        transientObserverCount--;
      }
    }
  }
  node._registeredObserverList = filtered;
}

// https://dom.spec.whatwg.org/#signal-slot-list
const signalSlotList = [];

// The private data passed to MutationRecord.create(). It is reused for every record (MutationRecordImpl copies what it
// needs, and nothing runs script while a record is created), and cleared afterwards so it does not keep nodes alive.
const recordInit = {
  type: null,
  target: null,
  attributeName: null,
  attributeNamespace: null,
  oldValue: null,
  addedNodes: null,
  removedNodes: null,
  previousSibling: null,
  nextSibling: null,
  wrapper: null
};

// Record queues hold MutationRecord wrappers rather than impls: they are only ever handed to script (the callback and
// takeRecords()), so this saves converting them on delivery.
function appendMutationRecord(observer, oldValue) {
  recordInit.oldValue = oldValue;
  observer._recordQueue.push(MutationRecord.create(recordInit.target._globalObject, [], recordInit));
  activeMutationObservers.add(observer);
}

// Kept out of queueMutationRecord, since a closure over its arguments would allocate a context on every call.
function filterIncludes(attributeFilter, name, namespace) {
  for (let i = 0; i < attributeFilter.length; i++) {
    const value = attributeFilter[i];
    if (value === name || value === namespace) {
      return true;
    }
  }
  return false;
}

// The interested observers of the mutation being queued, in the spec's map order, with their mapped old values. Module
// scope so that queueing does not allocate a map: queueMutationRecord() runs no script while it uses them, so it cannot
// be re-entered. An observer is deduplicated by stamping it with the walk's number and its index in these arrays.
const interestedObservers = [];
const mappedOldValues = [];
let interestedObserversWalk = 0;

// https://dom.spec.whatwg.org/#queue-a-mutation-record
// The added and removed nodes are passed as null for none, as a node for just that one, or as an array that the
// records may keep (the caller must not modify it afterwards), which avoids allocating lists when no observer wants
// the record.
function queueMutationRecord(
  type,
  target,
  name,
  namespace,
  oldValue,
  addedNodes,
  removedNodes,
  previousSibling,
  nextSibling
) {
  // No observer anywhere, or none ever registered in the target's node document (so none on its inclusive ancestors).
  if (registeredObserverCount === 0 || !target._ownerDocument._mutationObserversUsed) {
    queueMutationObserverMicrotask();
    return;
  }

  const bit = typeBit(type);
  const walk = ++interestedObserversWalk;
  let count = 0;

  // The inclusive ancestors are walked through their links objects, reading a node (whose many shapes make its own
  // properties slow to read here) only if it has had a registered observer. Nodes with registered observers have
  // links.
  for (let links = target._links; links !== null; links = links.parentLinks) {
    if ((links.flags & LINK_REGISTERED_OBSERVERS) === 0) {
      continue;
    }
    const { node } = links;
    const registeredObserverList = node._registeredObserverList;
    if (registeredObserverList === null) {
      continue;
    }

    for (let i = 0; i < registeredObserverList.length; i++) {
      const registered = registeredObserverList[i];

      if (
        (registered.types & bit) === 0 ||
        (node !== target && !registered.subtree) ||
        (bit === ATTRIBUTES_BIT && registered.attributeFilter !== null &&
          !filterIncludes(registered.attributeFilter, name, namespace))
      ) {
        continue;
      }

      const mo = registered.observer;
      if (mo._interestedWalk !== walk) {
        mo._interestedWalk = walk;
        mo._interestedIndex = count;
        interestedObservers[count] = mo;
        mappedOldValues[count] = null;
        count++;
      }
      if ((registered.oldValueTypes & bit) !== 0) {
        mappedOldValues[mo._interestedIndex] = oldValue;
      }
    }
  }

  if (count !== 0) {
    recordInit.type = type;
    recordInit.target = target;
    recordInit.attributeName = name;
    recordInit.attributeNamespace = namespace;
    recordInit.addedNodes = addedNodes;
    recordInit.removedNodes = removedNodes;
    recordInit.previousSibling = previousSibling;
    recordInit.nextSibling = nextSibling;

    for (let i = 0; i < count; i++) {
      appendMutationRecord(interestedObservers[i], mappedOldValues[i]);
      interestedObservers[i] = null;
      mappedOldValues[i] = null;
    }

    recordInit.target = null;
    recordInit.oldValue = null;
    recordInit.addedNodes = null;
    recordInit.removedNodes = null;
    recordInit.previousSibling = null;
    recordInit.nextSibling = null;
    recordInit.wrapper = null;
  }

  queueMutationObserverMicrotask();
}

// https://dom.spec.whatwg.org/#queue-a-tree-mutation-record
function queueTreeMutationRecord(target, addedNodes, removedNodes, previousSibling, nextSibling) {
  queueMutationRecord(
    MUTATION_TYPE.CHILD_LIST,
    target,
    null,
    null,
    null,
    addedNodes,
    removedNodes,
    previousSibling,
    nextSibling
  );
}

// https://dom.spec.whatwg.org/#queue-an-attribute-mutation-record
function queueAttributeMutationRecord(target, name, namespace, oldValue) {
  queueMutationRecord(
    MUTATION_TYPE.ATTRIBUTES,
    target,
    name,
    namespace,
    oldValue,
    null,
    null,
    null,
    null
  );
}

const resolvedPromise = Promise.resolve();

// https://dom.spec.whatwg.org/#queue-a-mutation-observer-compound-microtask
function queueMutationObserverMicrotask() {
  if (mutationObserverMicrotaskQueueFlag) {
    return;
  }

  mutationObserverMicrotaskQueueFlag = true;

  resolvedPromise.then(notifyMutationObservers);
}

// The steps of https://dom.spec.whatwg.org/#notify-mutation-observers for one observer.
function notifyMutationObserver(mo) {
  // This is a hot path, and replacing the record queue before invoking the callback makes it safe to hand the queue
  // itself to the callback: https://github.com/jsdom/jsdom/pull/4269
  const records = mo._recordQueue;
  mo._recordQueue = [];

  if (transientObserverCount !== 0) {
    for (const node of mo._nodeList) {
      filterRegisteredObservers(node, registeredObserver => {
        return registeredObserver.source !== mo;
      });
    }
  }

  if (records.length > 0) {
    try {
      const moWrapper = idlUtils.wrapperForImpl(mo);
      mo._callback.call(moWrapper, records, moWrapper);
    } catch (e) {
      const { target } = idlUtils.implForWrapper(records[0]);
      const window = target._ownerDocument._defaultView;

      reportException(window, e);
    }
  }
}

// https://dom.spec.whatwg.org/#notify-mutation-observers
function notifyMutationObservers() {
  mutationObserverMicrotaskQueueFlag = false;

  let notifyList = null;
  if (activeMutationObservers.size === 1) {
    notifyList = activeMutationObservers.values().next().value;
  } else if (activeMutationObservers.size > 1) {
    notifyList = [...activeMutationObservers].sort((a, b) => a._id - b._id);
  }
  activeMutationObservers.clear();

  let signalList = null;
  if (signalSlotList.length > 0) {
    signalList = [...signalSlotList];
    signalSlotList.length = 0;
  }

  if (notifyList !== null) {
    if (Array.isArray(notifyList)) {
      for (const mo of notifyList) {
        notifyMutationObserver(mo);
      }
    } else {
      notifyMutationObserver(notifyList);
    }
  }

  if (signalList === null) {
    return;
  }

  for (const slot of signalList) {
    const slotChangeEvent = Event.createImpl(
      slot._globalObject,
      [
        "slotchange",
        { bubbles: true }
      ],
      { isTrusted: true }
    );

    slot._dispatch(slotChangeEvent);
  }
}

module.exports = {
  MUTATION_TYPE,

  queueMutationRecord,
  queueTreeMutationRecord,
  queueAttributeMutationRecord,

  queueMutationObserverMicrotask,
  addRegisteredObserver,
  setRegisteredObserverOptions,
  filterRegisteredObservers,

  signalSlotList
};
