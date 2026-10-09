"use strict";
const CharacterDataImpl = require("./CharacterData-impl").implementation;
const NODE_TYPE = require("../node-type");
const { defineFieldDefaults } = require("../../utils");

class CommentImpl extends CharacterDataImpl {
  constructor(globalObject, args, privateData) {
    // Internal creation passes both fields; only the public constructor needs the defaults.
    const hasFields = "data" in privateData && "ownerDocument" in privateData;
    super(globalObject, args, hasFields ?
      privateData :
      { data: args[0], ownerDocument: globalObject._document, ...privateData });
  }
}

// Set on the prototype so the constructor stores fewer fields; see `defineFieldDefaults()`.
defineFieldDefaults(CommentImpl.prototype, { nodeType: NODE_TYPE.COMMENT_NODE });

module.exports = {
  implementation: CommentImpl
};
