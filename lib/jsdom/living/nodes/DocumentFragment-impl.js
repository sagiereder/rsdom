"use strict";
const { mixin } = require("../../utils");
const NODE_TYPE = require("../node-type");
const { findElementById } = require("../helpers/by-id-cache");
const NodeImpl = require("./Node-impl").implementation;
const NonElementParentNodeImpl = require("./NonElementParentNode-impl").implementation;
const ParentNodeImpl = require("./ParentNode-impl").implementation;

class DocumentFragmentImpl extends NodeImpl {
  constructor(globalObject, args, privateData) {
    super(globalObject, args, {
      ownerDocument: globalObject._document,
      ...privateData
    });

    const { host } = privateData;
    this._host = host;

    this.nodeType = NODE_TYPE.DOCUMENT_FRAGMENT_NODE;
  }

  // This is implemented separately for Document (which has a _byIdCache) and DocumentFragment (which does not).
  getElementById(id) {
    if (id === "") {
      return null;
    }

    return findElementById(this, this.firstChild, id);
  }
}

mixin(DocumentFragmentImpl.prototype, NonElementParentNodeImpl.prototype);
mixin(DocumentFragmentImpl.prototype, ParentNodeImpl.prototype);

module.exports = {
  implementation: DocumentFragmentImpl
};
