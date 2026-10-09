"use strict";
const DOMException = require("../../../generated/idl/DOMException");

const isWindow = require("../helpers/is-window");
const reportException = require("../helpers/runtime-script-errors");
const idlUtils = require("../../../generated/idl/utils");
const {
  isNode, isShadowRoot, isSlotable, getEventTargetParent,
  isShadowInclusiveAncestor, retarget
} = require("../helpers/shadow-dom");

const MouseEvent = require("../../../generated/idl/MouseEvent");
const fastPathFlags = require("../helpers/fast-path-flags");

const EVENT_PHASE = {
  NONE: 0,
  CAPTURING_PHASE: 1,
  AT_TARGET: 2,
  BUBBLING_PHASE: 3
};

// An event path struct (https://dom.spec.whatwg.org/#concept-event-path). `effectiveTarget` caches the closest non-null
// shadow-adjusted target at or before this struct, which the invoke algorithm would otherwise search for.
class PathStruct {
  constructor(item, shadowAdjustedTarget, effectiveTarget, relatedTarget, touchTargets) {
    this.item = item;
    this.itemInShadowTree = false;
    this.shadowAdjustedTarget = shadowAdjustedTarget;
    this.effectiveTarget = effectiveTarget;
    this.relatedTarget = relatedTarget;
    this.touchTargets = touchTargets;
    this.rootOfClosedTree = false;
    this.slotInClosedTree = false;
    // The item's wrapper, looked up on first invocation (an implementation detail, not part of the spec struct).
    this.itemWrapper = undefined;
  }
}

class EventTargetImpl {
  constructor(globalObject) {
    this._globalObject = globalObject;
    this._eventListeners = null;
  }

  // Default argument is necessary because webidl2js cannot handle `= {}` with unions at the moment.
  addEventListener(type, callback, options = { __proto__: null, capture: false, once: false }) {
    let { capture, once, passive, signal } = flattenMoreEventListenerOptions(options);

    if (signal !== null && signal.aborted) {
      return;
    }

    if (callback === null) {
      return;
    }

    if (passive === null) {
      passive = defaultPassiveValue(type, this);
    }

    if (this._eventListeners === null) {
      this._eventListeners = Object.create(null);
    }
    let listeners = this._eventListeners[type];
    if (!listeners) {
      listeners = this._eventListeners[type] = newListenerList();
    }

    for (let i = 0; i < listeners.length; ++i) {
      const listener = listeners[i];
      if (
        listener.callback.objectReference === callback.objectReference &&
        listener.capture === capture
      ) {
        return;
      }
    }

    if (listeners.iterating !== 0) {
      listeners = this._eventListeners[type] = copyListenerList(listeners);
    }
    const listener = {
      callback,
      capture,
      once,
      passive,
      signal,
      removed: false
    };
    listeners.push(listener);

    if (signal !== null) {
      // The signal stores abort algorithms by identity. Keep the exact function on the listener record so removing the
      // listener can also discard its now-redundant abort algorithm instead of retaining the record and its callback.
      listener.abortAlgorithm = () => {
        removeEventListenerFromList(this, type, listener);
      };
      signal._addAlgorithm(listener.abortAlgorithm);
    }
  }

  // Default argument is necessary because webidl2js cannot handle `= {}` with unions at the moment.
  removeEventListener(type, callback, options = { __proto__: null, capture: false }) {
    const capture = flattenEventListenerOptions(options);

    if (callback === null) {
      // Optimization, not in the spec.
      return;
    }

    if (this._eventListeners === null || !this._eventListeners[type]) {
      return;
    }

    const listeners = this._eventListeners[type];
    for (let i = 0; i < listeners.length; ++i) {
      const listener = listeners[i];
      if (
        listener.callback.objectReference === callback.objectReference &&
        listener.capture === capture
      ) {
        removeEventListenerFromList(this, type, listener);
        break;
      }
    }
  }

  // https://dom.spec.whatwg.org/#concept-event-listener-remove-all
  _removeAllEventListeners() {
    if (this._eventListeners === null) {
      return;
    }

    // The listener map can be discarded at once, but signal-bound listeners also have a backlink from their signal.
    for (const listeners of Object.values(this._eventListeners)) {
      for (const listener of listeners) {
        listener.removed = true;
        removeAbortAlgorithm(listener);
      }
    }

    this._eventListeners = null;
  }

  dispatchEvent(eventImpl) {
    if (eventImpl._dispatchFlag || !eventImpl._initializedFlag) {
      throw DOMException.create(this._globalObject, [
        "Tried to dispatch an uninitialized event",
        "InvalidStateError"
      ]);
    }
    if (eventImpl.eventPhase !== EVENT_PHASE.NONE) {
      throw DOMException.create(this._globalObject, [
        "Tried to dispatch a dispatching event",
        "InvalidStateError"
      ]);
    }

    eventImpl.isTrusted = false;

    return this._dispatch(eventImpl);
  }

  // https://dom.spec.whatwg.org/#get-the-parent
  _getTheParent() {
    return null;
  }

  // https://dom.spec.whatwg.org/#concept-event-dispatch
  // legacyOutputDidListenersThrowFlag optional parameter is not necessary here since it is only used by indexDB.
  _dispatch(eventImpl, legacyTargetOverrideFlag /* , legacyOutputDidListenersThrowFlag */) {
    let targetImpl = this;
    let clearTargets = false;
    let activationTarget = null;

    eventImpl._dispatchFlag = true;

    const targetOverride = legacyTargetOverrideFlag ?
      targetImpl._globalObject._document :
      targetImpl;
    // Without any shadow roots, retargeting never changes a target, nothing is in a shadow tree or assigned to a slot,
    // and every node on the event path is an ancestor of the target, so it is in the target's tree.
    const { shadowRoots } = fastPathFlags;
    let relatedTarget = shadowRoots ? retarget(eventImpl.relatedTarget, targetImpl) : eventImpl.relatedTarget;

    if (!shadowRoots) {
      // Without shadow roots the event path is the target followed by its parents (get the parent never yields a
      // slot or a shadow root), each of which is a node in the target's tree or the window, so every entry takes the
      // "append to an event path with parent, null, relatedTarget, touchTargets, false" branch.
      const touchTargets = [];
      const path = eventImpl._path;
      path.push(new PathStruct(targetImpl, targetOverride, targetOverride, relatedTarget, touchTargets));

      const isActivationEvent = MouseEvent.isImpl(eventImpl) && eventImpl.type === "click";
      if (isActivationEvent && targetImpl._hasActivationBehavior) {
        activationTarget = targetImpl;
      }
      const lookForActivationTarget = isActivationEvent && eventImpl.bubbles;

      let parent = nextEventTargetParent(targetImpl, eventImpl);
      while (parent !== null) {
        if (lookForActivationTarget && activationTarget === null && parent._hasActivationBehavior) {
          activationTarget = parent;
        }
        path.push(new PathStruct(parent, null, targetOverride, relatedTarget, touchTargets));
        parent = nextEventTargetParent(parent, eventImpl);
      }

      if (activationTarget !== null && activationTarget._legacyPreActivationBehavior) {
        activationTarget._legacyPreActivationBehavior();
      }

      invokeAlongPath(eventImpl, path);
    } else if (targetImpl !== relatedTarget || targetImpl === eventImpl.relatedTarget) {
      const touchTargets = [];

      appendToEventPath(eventImpl, targetImpl, targetOverride, relatedTarget, touchTargets, false);

      const isActivationEvent = MouseEvent.isImpl(eventImpl) && eventImpl.type === "click";

      if (isActivationEvent && targetImpl._hasActivationBehavior) {
        activationTarget = targetImpl;
      }

      let slotInClosedTree = false;
      let slotable = shadowRoots && isSlotable(targetImpl) && targetImpl._assignedSlot ? targetImpl : null;
      let parent = getEventTargetParent(targetImpl, eventImpl);

      // Populate event path
      // https://dom.spec.whatwg.org/#event-path
      while (parent !== null) {
        if (slotable !== null) {
          if (parent.localName !== "slot") {
            throw new Error(`JSDOM Internal Error: Expected parent to be a Slot`);
          }

          slotable = null;

          const parentRoot = parent.getRootNode();
          if (isShadowRoot(parentRoot) && parentRoot.mode === "closed") {
            slotInClosedTree = true;
          }
        }

        if (shadowRoots && isSlotable(parent) && parent._assignedSlot) {
          slotable = parent;
        }

        relatedTarget = shadowRoots ? retarget(eventImpl.relatedTarget, parent) : eventImpl.relatedTarget;

        if (
          (isNode(parent) && (!shadowRoots || isShadowInclusiveAncestor(targetImpl.getRootNode(), parent))) ||
          isWindow(parent)
        ) {
          if (isActivationEvent && eventImpl.bubbles && activationTarget === null &&
              parent._hasActivationBehavior) {
            activationTarget = parent;
          }

          appendToEventPath(eventImpl, parent, null, relatedTarget, touchTargets, slotInClosedTree);
        } else if (parent === relatedTarget) {
          parent = null;
        } else {
          targetImpl = parent;

          if (isActivationEvent && activationTarget === null && targetImpl._hasActivationBehavior) {
            activationTarget = targetImpl;
          }

          appendToEventPath(eventImpl, parent, targetImpl, relatedTarget, touchTargets, slotInClosedTree);
        }

        if (parent !== null) {
          parent = getEventTargetParent(parent, eventImpl);
        }

        slotInClosedTree = false;
      }

      let clearTargetsStructIndex = -1;
      for (let i = eventImpl._path.length - 1; i >= 0 && clearTargetsStructIndex === -1; i--) {
        if (eventImpl._path[i].shadowAdjustedTarget !== null) {
          clearTargetsStructIndex = i;
        }
      }
      const clearTargetsStruct = eventImpl._path[clearTargetsStructIndex];

      clearTargets = shadowRoots && (
        (isNode(clearTargetsStruct.shadowAdjustedTarget) &&
          isShadowRoot(clearTargetsStruct.shadowAdjustedTarget.getRootNode())) ||
          (isNode(clearTargetsStruct.relatedTarget) && isShadowRoot(clearTargetsStruct.relatedTarget.getRootNode())));

      if (activationTarget !== null && activationTarget._legacyPreActivationBehavior) {
        activationTarget._legacyPreActivationBehavior();
      }

      invokeAlongPath(eventImpl, eventImpl._path);
    }

    eventImpl.eventPhase = EVENT_PHASE.NONE;

    eventImpl.currentTarget = null;
    eventImpl._path = [];
    eventImpl._dispatchFlag = false;
    eventImpl._stopPropagationFlag = false;
    eventImpl._stopImmediatePropagationFlag = false;

    if (clearTargets) {
      eventImpl.target = null;
      eventImpl.relatedTarget = null;
    }

    if (activationTarget !== null) {
      if (!eventImpl._canceledFlag) {
        activationTarget._activationBehavior(eventImpl);
      } else if (activationTarget._legacyCanceledActivationBehavior) {
        activationTarget._legacyCanceledActivationBehavior();
      }
    }

    return !eventImpl._canceledFlag;
  }
}

module.exports = {
  implementation: EventTargetImpl
};

function invokeAlongPath(eventImpl, path) {
  for (let i = path.length - 1; i >= 0; --i) {
    const struct = path[i];

    if (struct.shadowAdjustedTarget !== null) {
      eventImpl.eventPhase = EVENT_PHASE.AT_TARGET;
    } else {
      eventImpl.eventPhase = EVENT_PHASE.CAPTURING_PHASE;
    }

    invokeEventListeners(struct, eventImpl, true);
  }

  let finalStruct;
  for (let i = 0; i < path.length; i++) {
    const struct = path[i];

    if (struct.shadowAdjustedTarget !== null) {
      eventImpl.eventPhase = EVENT_PHASE.AT_TARGET;
    } else {
      if (!eventImpl.bubbles) {
        continue;
      }

      eventImpl.eventPhase = EVENT_PHASE.BUBBLING_PHASE;
    }

    finalStruct = struct;
    invokeEventListeners(struct, eventImpl, false);
  }

  // Listenerless path entries skip target updates, so apply the state from the last entry selected for invocation.
  updateEventTargets(eventImpl, finalStruct);
}

// https://dom.spec.whatwg.org/#get-the-parent, for when no shadow roots exist: a node's parent is its tree parent
// (nothing is assigned to a slot), and only parentless targets (documents, the window, non-node targets) need their
// own "get the parent".
function nextEventTargetParent(eventTarget, eventImpl) {
  const links = eventTarget._links;
  if (links !== undefined && links !== null && links.parent !== null) {
    return links.parent;
  }
  return getEventTargetParent(eventTarget, eventImpl);
}

// Listener lists are copy-on-write while being iterated: `iterating` counts the (possibly nested) inner invokes
// walking a list, and add/remove replace a list that is being walked with a copy instead of mutating it. That gives
// every invocation the snapshot semantics of "let listeners be a clone of event's currentTarget's event listener list"
// without cloning on every invoke.
function newListenerList() {
  const list = [];
  list.iterating = 0;
  return list;
}

function copyListenerList(list) {
  const copy = list.slice();
  copy.iterating = 0;
  return copy;
}

// https://dom.spec.whatwg.org/#concept-event-listener-invoke
// `capturing` is true for the capturing phase and false for the bubbling phase.
function invokeEventListeners(struct, eventImpl, capturing) {
  const listeners = struct.item._eventListeners;
  const typeListeners = listeners === null ? undefined : listeners[eventImpl.type];
  if (!typeListeners || typeListeners.length === 0) {
    // With no listeners, inner invoke does nothing observable: target/relatedTarget are re-applied before any later
    // listener runs and after dispatch, and currentTarget is reset to null after dispatch.
    return;
  }

  updateEventTargets(eventImpl, struct);

  if (eventImpl._stopPropagationFlag) {
    return;
  }

  let { itemWrapper } = struct;
  if (itemWrapper === undefined) {
    itemWrapper = struct.itemWrapper = idlUtils.wrapperForImpl(struct.item);
  }
  eventImpl.currentTarget = itemWrapper;

  innerInvokeEventListeners(eventImpl, struct.item, typeListeners, capturing, struct.itemInShadowTree);
}

function updateEventTargets(eventImpl, struct) {
  eventImpl.target = struct.effectiveTarget;
  eventImpl.relatedTarget = struct.relatedTarget;
}

// https://dom.spec.whatwg.org/#concept-event-listener-inner-invoke
// `typeListeners` is the target's listener list for the event's type.
function innerInvokeEventListeners(eventImpl, item, typeListeners, capturing, itemInShadowTree) {
  const { type } = eventImpl;
  const window = eventImpl.target._globalObject;
  const thisArg = eventImpl.currentTarget;
  let eventWrapper;

  typeListeners.iterating++;
  try {
    for (let i = 0; i < typeListeners.length; i++) {
      const listener = typeListeners[i];

      // Skip listeners removed since the walk started, and listeners for the other phase.
      if (listener.removed || listener.capture !== capturing) {
        continue;
      }

      if (listener.once) {
        removeEventListenerFromList(item, type, listener);
      }

      let currentEvent;
      if (window) {
        currentEvent = window._currentEvent;
        if (!itemInShadowTree) {
          window._currentEvent = eventImpl;
        }
      }

      if (listener.passive) {
        eventImpl._inPassiveListenerFlag = true;
      }

      try {
        const { callback } = listener;
        // Callbacks converted by the EventListener callback interface carry the user's object. Calling a plain
        // function directly is exactly what the converted callback would do (this = currentTarget, the event's
        // wrapper as the only argument, result ignored). Internal (impl-side) listeners receive the impl.
        const ref = callback.objectReference;
        if (typeof ref === "function") {
          if (eventWrapper === undefined) {
            eventWrapper = idlUtils.wrapperForImpl(eventImpl);
          }
          ref.call(thisArg, eventWrapper);
        } else {
          callback.call(thisArg, eventImpl);
        }
      } catch (e) {
        if (window) {
          reportException(window, e);
        }
        // Errors in window-less documents just get swallowed... can you think of anything better?
      }

      eventImpl._inPassiveListenerFlag = false;

      if (window) {
        window._currentEvent = currentEvent;
      }

      if (eventImpl._stopImmediatePropagationFlag) {
        return;
      }
    }
  } finally {
    typeListeners.iterating--;
  }
}

// https://dom.spec.whatwg.org/#remove-an-event-listener
function removeEventListenerFromList(eventTarget, type, listener) {
  listener.removed = true;
  removeAbortAlgorithm(listener);

  const map = eventTarget._eventListeners;
  let list = map === null ? undefined : map[type];
  if (!list) {
    return;
  }
  const index = list.indexOf(listener);
  if (index === -1) {
    return;
  }
  if (list.iterating !== 0) {
    list = map[type] = copyListenerList(list);
  }
  list.splice(index, 1);
}

function removeAbortAlgorithm(listener) {
  if (listener.signal !== null) {
    // This registration is going away, so aborting its signal no longer needs to remove it.
    listener.signal._removeAlgorithm(listener.abortAlgorithm);
  }
}

function flattenMoreEventListenerOptions(options) {
  const dict = {
    capture: flattenEventListenerOptions(options),
    once: false,
    passive: null,
    signal: null
  };

  if (options !== null && typeof options === "object") {
    dict.once = options.once;
    if ("passive" in options) {
      dict.passive = options.passive;
    }
    if ("signal" in options) {
      dict.signal = options.signal;
    }
  }
  return dict;
}

function flattenEventListenerOptions(options) {
  if (typeof options === "boolean") {
    return options;
  }
  // Internal callers may pass dictionaries without a capture member.
  return Boolean(options.capture);
}

function defaultPassiveValue(type, eventTarget) {
  switch (type) {
    case "touchstart":
    case "touchmove":
    case "wheel":
    case "mousewheel":
      if (isWindow(eventTarget)) {
        return true;
      }
      if (!isNode(eventTarget)) {
        return false;
      }

      return eventTarget._ownerDocument === eventTarget ||
        eventTarget._ownerDocument.documentElement === eventTarget ||
        eventTarget._ownerDocument.body === eventTarget;
    default:
      return false;
  }
}

// https://dom.spec.whatwg.org/#concept-event-path-append
function appendToEventPath(
  eventImpl,
  invocationTarget,
  shadowAdjustedTarget,
  relatedTarget,
  touchTargets,
  slotInClosedTree
) {
  const { shadowRoots } = fastPathFlags;
  const itemInShadowTree = shadowRoots && isNode(invocationTarget) && isShadowRoot(invocationTarget.getRootNode());
  const rootOfClosedTree = shadowRoots && isShadowRoot(invocationTarget) && invocationTarget.mode === "closed";
  const previousStruct = eventImpl._path[eventImpl._path.length - 1];

  // The invoke algorithm searches backward for the closest non-null shadow-adjusted target. Cache that result while
  // building the path so that each invocation can use it directly.
  const effectiveTarget = shadowAdjustedTarget === null ? previousStruct.effectiveTarget : shadowAdjustedTarget;

  const struct = new PathStruct(invocationTarget, shadowAdjustedTarget, effectiveTarget, relatedTarget, touchTargets);
  struct.itemInShadowTree = itemInShadowTree;
  struct.rootOfClosedTree = rootOfClosedTree;
  struct.slotInClosedTree = slotInClosedTree;
  eventImpl._path.push(struct);
}
