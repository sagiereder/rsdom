"use strict";
const SlotableMixinImpl = require("./Slotable-impl").implementation;
const CharacterDataImpl = require("./CharacterData-impl").implementation;
const DOMException = require("../../../generated/idl/DOMException");
const NODE_TYPE = require("../node-type");
const { mixin, defineFieldDefaults } = require("../../utils");

// https://dom.spec.whatwg.org/#text
class TextImpl extends CharacterDataImpl {
  constructor(globalObject, args, privateData) {
    // Internal creation passes both fields; only the public constructor needs the defaults.
    const hasFields = "data" in privateData && "ownerDocument" in privateData;
    super(globalObject, args, hasFields ?
      privateData :
      { data: args[0], ownerDocument: globalObject._document, ...privateData });

    // `_slotableName` and `nodeType` start at their prototype defaults.
  }

  // https://dom.spec.whatwg.org/#dom-text-splittext
  // https://dom.spec.whatwg.org/#concept-text-split
  splitText(offset) {
    const { length } = this;

    if (offset > length) {
      throw DOMException.create(this._globalObject, ["The index is not in the allowed range.", "IndexSizeError"]);
    }

    const count = length - offset;
    const newData = this.substringData(offset, count);

    const newNode = this._ownerDocument.createTextNode(newData);

    const parent = this.parentNode;

    if (parent !== null) {
      parent._insert(newNode, this.nextSibling);

      for (const range of this._liveRanges()) {
        const { _start, _end } = range;

        if (_start.node === this && _start.offset > offset) {
          range._setLiveRangeStart(newNode, _start.offset - offset);
        }

        if (_end.node === this && _end.offset > offset) {
          range._setLiveRangeEnd(newNode, _end.offset - offset);
        }
      }

      const nodeIndex = this._treeIndex();
      for (const range of parent._liveRanges()) {
        const { _start, _end } = range;

        if (_start.node === parent && _start.offset === nodeIndex + 1) {
          range._setLiveRangeStart(parent, _start.offset + 1);
        }

        if (_end.node === parent && _end.offset === nodeIndex + 1) {
          range._setLiveRangeEnd(parent, _end.offset + 1);
        }
      }
    }

    this.replaceData(offset, count, "");

    return newNode;
  }

  // https://dom.spec.whatwg.org/#dom-text-wholetext
  get wholeText() {
    let wholeText = this.textContent;
    let next;
    let current = this;
    while ((next = current.previousSibling) && next.nodeType === NODE_TYPE.TEXT_NODE) {
      wholeText = next.textContent + wholeText;
      current = next;
    }
    current = this;
    while ((next = current.nextSibling) && next.nodeType === NODE_TYPE.TEXT_NODE) {
      wholeText += next.textContent;
      current = next;
    }
    return wholeText;
  }
}

mixin(TextImpl.prototype, SlotableMixinImpl.prototype);

// Set on the prototype so the constructor stores fewer fields; see `defineFieldDefaults()`.
defineFieldDefaults(TextImpl.prototype, { nodeType: NODE_TYPE.TEXT_NODE, _slotableName: "" });

module.exports = {
  implementation: TextImpl
};
