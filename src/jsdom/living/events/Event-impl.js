"use strict";

const idlUtils = require("../../../generated/idl/utils");
const EventInit = require("../../../generated/idl/EventInit");

const initDictAppliers = new WeakMap();

// Builds (once per event impl class) a function that applies the members of defaultInit to an impl, taking each from
// the init dictionary when present there. Member names come from the class's IDL dictionary.
function getInitDictApplier(ctor) {
  let applier = initDictAppliers.get(ctor);
  if (applier === undefined) {
    let body = "";
    for (const key in ctor.defaultInit) {
      const k = JSON.stringify(key);
      body += `self[${k}] = ${k} in dict ? dict[${k}] : defaults[${k}];\n`;
    }
    // eslint-disable-next-line no-new-func
    applier = new Function("self", "dict", "defaults", body);
    initDictAppliers.set(ctor, applier);
  }
  return applier;
}

class EventImpl {
  constructor(globalObject, args, privateData) {
    const { defaultInit } = this.constructor;
    const type = args[0];
    let eventInitDict = args[1];
    if (eventInitDict === undefined) {
      eventInitDict = defaultInit;
    }

    this.type = type;

    this.bubbles = false;
    this.cancelable = false;
    if (defaultInit !== undefined && eventInitDict !== undefined && eventInitDict !== null) {
      // Equivalent to copying every member of eventInitDict, then every member of defaultInit missing from it, but with
      // named stores so that impls of one class share a shape.
      getInitDictApplier(this.constructor)(this, eventInitDict, defaultInit);
      for (const key in eventInitDict) {
        if (!(key in defaultInit)) {
          this[key] = eventInitDict[key];
        }
      }
    } else {
      for (const key in eventInitDict) {
        this[key] = eventInitDict[key];
      }
      for (const key in defaultInit) {
        if (!(key in eventInitDict)) {
          this[key] = defaultInit[key];
        }
      }
    }

    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;

    this._globalObject = globalObject;
    this._initializedFlag = true;
    this._stopPropagationFlag = false;
    this._stopImmediatePropagationFlag = false;
    this._canceledFlag = false;
    this._inPassiveListenerFlag = false;
    this._dispatchFlag = false;
    this._path = [];

    this.isTrusted = privateData.isTrusted || false;
    this.timeStamp = Date.now();
  }

  // https://dom.spec.whatwg.org/#set-the-canceled-flag
  _setTheCanceledFlag() {
    if (this.cancelable && !this._inPassiveListenerFlag) {
      this._canceledFlag = true;
    }
  }

  get srcElement() {
    return this.target;
  }

  get returnValue() {
    return !this._canceledFlag;
  }

  set returnValue(v) {
    if (v === false) {
      this._setTheCanceledFlag();
    }
  }

  get defaultPrevented() {
    return this._canceledFlag;
  }

  stopPropagation() {
    this._stopPropagationFlag = true;
  }

  get cancelBubble() {
    return this._stopPropagationFlag;
  }

  set cancelBubble(v) {
    if (v) {
      this._stopPropagationFlag = true;
    }
  }

  stopImmediatePropagation() {
    this._stopPropagationFlag = true;
    this._stopImmediatePropagationFlag = true;
  }

  preventDefault() {
    this._setTheCanceledFlag();
  }

  // https://dom.spec.whatwg.org/#dom-event-composedpath
  // Current implementation is based of https://whatpr.org/dom/699.html#dom-event-composedpath
  // due to a bug in composed path implementation https://github.com/whatwg/dom/issues/684
  composedPath() {
    const composedPath = [];

    const { currentTarget, _path: path } = this;

    if (path.length === 0) {
      return composedPath;
    }

    composedPath.push(currentTarget);

    let currentTargetIndex = 0;
    let currentTargetHiddenSubtreeLevel = 0;

    for (let index = path.length - 1; index >= 0; index--) {
      const { item, rootOfClosedTree, slotInClosedTree } = path[index];

      if (rootOfClosedTree) {
        currentTargetHiddenSubtreeLevel++;
      }

      if (item === idlUtils.implForWrapper(currentTarget)) {
        currentTargetIndex = index;
        break;
      }

      if (slotInClosedTree) {
        currentTargetHiddenSubtreeLevel--;
      }
    }

    let currentHiddenLevel = currentTargetHiddenSubtreeLevel;
    let maxHiddenLevel = currentTargetHiddenSubtreeLevel;

    for (let i = currentTargetIndex - 1; i >= 0; i--) {
      const { item, rootOfClosedTree, slotInClosedTree } = path[i];

      if (rootOfClosedTree) {
        currentHiddenLevel++;
      }

      if (currentHiddenLevel <= maxHiddenLevel) {
        composedPath.unshift(idlUtils.wrapperForImpl(item));
      }

      if (slotInClosedTree) {
        currentHiddenLevel--;
        if (currentHiddenLevel < maxHiddenLevel) {
          maxHiddenLevel = currentHiddenLevel;
        }
      }
    }

    currentHiddenLevel = currentTargetHiddenSubtreeLevel;
    maxHiddenLevel = currentTargetHiddenSubtreeLevel;

    for (let index = currentTargetIndex + 1; index < path.length; index++) {
      const { item, rootOfClosedTree, slotInClosedTree } = path[index];

      if (slotInClosedTree) {
        currentHiddenLevel++;
      }

      if (currentHiddenLevel <= maxHiddenLevel) {
        composedPath.push(idlUtils.wrapperForImpl(item));
      }

      if (rootOfClosedTree) {
        currentHiddenLevel--;
        if (currentHiddenLevel < maxHiddenLevel) {
          maxHiddenLevel = currentHiddenLevel;
        }
      }
    }

    return composedPath;
  }

  _initialize(type, bubbles, cancelable) {
    this.type = type;
    this._initializedFlag = true;

    this._stopPropagationFlag = false;
    this._stopImmediatePropagationFlag = false;
    this._canceledFlag = false;

    this.isTrusted = false;
    this.target = null;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
  }

  initEvent(type, bubbles, cancelable) {
    if (this._dispatchFlag) {
      return;
    }

    this._initialize(type, bubbles, cancelable);
  }
}
EventImpl.defaultInit = EventInit.convert(undefined, undefined);

module.exports = {
  implementation: EventImpl
};
