"use strict";

const IterableWeakList = require("../helpers/iterable-weak-list");
const {
  filterRegisteredObservers,
  addRegisteredObserver,
  setRegisteredObserverOptions
} = require("../helpers/mutation-observers");

// If we were to implement the MutationObserver by spec, the MutationObservers will not be collected by the GC because
// all the MO are kept in a mutation observer list (https://github.com/jsdom/jsdom/pull/2398/files#r238123889). The
// mutation observer list is primarily used to invoke the mutation observer callback in the same order than the
// mutation observer creation.
// In order to get around this issue, we will assign an increasing id for each mutation observer, this way we would be
// able to invoke the callback in the creation order without having to keep a list of all the mutation observers.
let mutationObserverId = 0;

// https://dom.spec.whatwg.org/#mutationobserver
class MutationObserverImpl {
  // https://dom.spec.whatwg.org/#dom-mutationobserver-mutationobserver
  constructor(globalObject, args) {
    const [callback] = args;

    this._callback = callback;
    this._nodeList = new IterableWeakList();
    // MutationRecord wrappers
    this._recordQueue = [];

    this._id = ++mutationObserverId;

    // Scratch state of queueMutationRecord()'s interested-observers walk.
    this._interestedWalk = 0;
    this._interestedIndex = 0;
  }

  // https://dom.spec.whatwg.org/#dom-mutationobserver-observe
  observe(target, options) {
    if (("attributeOldValue" in options || "attributeFilter" in options) && !("attributes" in options)) {
      options.attributes = true;
    }

    if ("characterDataOldValue" in options && !("characterData" in options)) {
      options.characterData = true;
    }

    if (!options.childList && !options.attributes && !options.characterData) {
      throw new TypeError("The options object must set at least one of 'attributes', 'characterData', or 'childList' " +
        "to true.");
    } else if (options.attributeOldValue && !options.attributes) {
      throw new TypeError("The options object may only set 'attributeOldValue' to true when 'attributes' is true or " +
        "not present.");
    } else if (("attributeFilter" in options) && !options.attributes) {
      throw new TypeError("The options object may only set 'attributeFilter' when 'attributes' is true or not " +
        "present.");
    } else if (options.characterDataOldValue && !options.characterData) {
      throw new TypeError("The options object may only set 'characterDataOldValue' to true when 'characterData' is " +
        "true or not present.");
    }

    const existingRegisteredObserver = target._registeredObserverList?.find(registeredObserver => {
      return registeredObserver.observer === this;
    });

    if (existingRegisteredObserver) {
      for (const node of this._nodeList) {
        filterRegisteredObservers(node, registeredObserver => {
          return registeredObserver.source !== existingRegisteredObserver;
        });
      }

      setRegisteredObserverOptions(existingRegisteredObserver, options);
    } else {
      const registeredObserver = {
        observer: this,
        options: null,
        subtree: false,
        types: 0,
        oldValueTypes: 0,
        attributeFilter: null
      };
      setRegisteredObserverOptions(registeredObserver, options);

      addRegisteredObserver(target, registeredObserver);

      this._nodeList.append(target);
    }
  }

  // https://dom.spec.whatwg.org/#dom-mutationobserver-disconnect
  disconnect() {
    for (const node of this._nodeList) {
      filterRegisteredObservers(node, registeredObserver => {
        return registeredObserver.observer !== this;
      });
    }

    this._recordQueue = [];
    this._nodeList.clear();
  }

  // https://dom.spec.whatwg.org/#dom-mutationobserver-takerecords
  takeRecords() {
    const records = this._recordQueue;
    this._recordQueue = [];

    return records;
  }
}

module.exports = {
  implementation: MutationObserverImpl
};
