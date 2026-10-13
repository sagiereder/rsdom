"use strict";
// @asamuzakjp/dom-selector's DOMSelector, when created, registers capturing listeners on the window for focus, keyboard
// and mouse events, and keeps the last focus event and the last (non-modifier key) keyboard or mouse event, which it
// uses to match :focus-visible (see its src/js/event.js). So when a DOMSelector is created affects which elements match
// :focus-visible.
//
// Some code that used to create the DOMSelector no longer needs it (see computed-style.js's matchIndexEntry()). To keep
// :focus-visible matching as it was, that code creates an EventRecorder instead, which registers the same listeners at
// that point (same window, event types, options and order) and records the same events. When the DOMSelector is later
// created, createDOMSelector() captures the listeners it registers instead of registering them, hands them the recorded
// events, and from then on the recorder's listeners forward events to them.

// dom-selector's KEYS_MODIFIER: the keys whose keyboard events it ignores.
const MODIFIER_KEYS = new Set([
  "Alt", "AltGraph", "CapsLock", "Control", "Fn", "FnLock", "Hyper", "Meta", "NumLock", "ScrollLock", "Shift", "Super",
  "Symbol", "SymbolLock"
]);

// The listeners dom-selector registers, in its order: one handler per group of event types.
const FOCUS = 0;
const KEYBOARD = 1;
const MOUSE = 2;
const EVENT_GROUPS = [
  [FOCUS, ["focus", "focusin"]],
  [KEYBOARD, ["keydown", "keyup"]],
  [MOUSE, ["mouseover", "mousedown", "mouseup", "click", "mouseout"]]
];

class EventRecorder {
  #focusEvent = null;
  #event = null;
  // The DOMSelector's listeners by event type, once it is created.
  #handlers = null;

  constructor(window) {
    for (const [group, types] of EVENT_GROUPS) {
      const listener = event => this.#handle(group, event);
      for (const type of types) {
        window.addEventListener(type, listener, { capture: true, passive: true });
      }
    }
  }

  #handle(group, event) {
    if (this.#handlers !== null) {
      this.#handlers.get(event.type)?.(event);
    } else if (group === FOCUS) {
      this.#focusEvent = event;
    } else if (group === MOUSE || !MODIFIER_KEYS.has(event.key)) {
      this.#event = event;
    }
  }

  // Hands the recorded events to the DOMSelector's listeners, and forwards later events to them.
  attach(handlers) {
    this.#handlers = handlers;
    if (this.#focusEvent !== null) {
      handlers.get(this.#focusEvent.type)?.(this.#focusEvent);
    }
    if (this.#event !== null) {
      handlers.get(this.#event.type)?.(this.#event);
    }
    this.#focusEvent = null;
    this.#event = null;
  }
}

// Creates a DOMSelector for the document. With a recorder, its listeners are captured instead of registered (by
// temporarily shadowing the window's addEventListener with an own property), and attached to the recorder.
function createDOMSelector(window, document, idlUtils, recorder) {
  // Required here rather than at the top: loading the selector engine takes tens of milliseconds, a cost every
  // process (e.g. every Vitest test file) would otherwise pay up front even if nothing ever needs it.
  const { DOMSelector } = require("@asamuzakjp/dom-selector");
  if (recorder === null) {
    return new DOMSelector(window, document, { idlUtils });
  }

  const handlers = new Map();
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener");
  let intercepting = false;
  if (ownDescriptor === undefined || ownDescriptor.configurable) {
    try {
      Object.defineProperty(window, "addEventListener", {
        configurable: true,
        writable: true,
        value(type, handler) {
          handlers.set(type, handler);
        }
      });
      intercepting = true;
    } catch {
      // A non-extensible window. The DOMSelector then registers its listeners itself.
    }
  }
  try {
    return new DOMSelector(window, document, { idlUtils });
  } finally {
    if (intercepting) {
      if (ownDescriptor === undefined) {
        delete window.addEventListener;
      } else {
        Object.defineProperty(window, "addEventListener", ownDescriptor);
      }
      recorder.attach(handlers);
    }
  }
}

exports.EventRecorder = EventRecorder;
exports.createDOMSelector = createDOMSelector;
