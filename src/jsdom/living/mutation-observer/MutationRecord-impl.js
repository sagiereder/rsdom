"use strict";

const NodeList = require("../../../generated/idl/NodeList");

// https://dom.spec.whatwg.org/#mutationrecord
class MutationRecordImpl {
  constructor(globalObject, args, privateData) {
    this._globalObject = globalObject;

    this.type = privateData.type;
    this.target = privateData.target;
    this.previousSibling = privateData.previousSibling;
    this.nextSibling = privateData.nextSibling;
    this.attributeName = privateData.attributeName;
    this.attributeNamespace = privateData.attributeNamespace;
    this.oldValue = privateData.oldValue;

    // null, a node, or an array of nodes
    this._addedNodes = privateData.addedNodes;
    this._removedNodes = privateData.removedNodes;
  }

  // The wrapper caches these ([SameObject]), so each list is created at most once, and only if script reads it.
  get addedNodes() {
    return createNodeList(this._globalObject, this._addedNodes);
  }

  get removedNodes() {
    return createNodeList(this._globalObject, this._removedNodes);
  }
}

// `nodes` is null for none, a node for just that one, or an array (possibly shared with other records, so it is
// copied).
function createNodeList(globalObject, nodes) {
  if (nodes === null) {
    return NodeList.createImpl(globalObject, [], { nodes: [], adoptNodes: true });
  }
  if (Array.isArray(nodes)) {
    return NodeList.createImpl(globalObject, [], { nodes });
  }
  return NodeList.createImpl(globalObject, [], { nodes: [nodes], adoptNodes: true });
}

module.exports = {
  implementation: MutationRecordImpl
};
