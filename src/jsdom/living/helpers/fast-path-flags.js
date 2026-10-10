"use strict";

// Per-document, monotonic flags that let hot tree-mutation and event-dispatch paths skip work that can only matter once
// a feature has been used. They live on Document impls as `_shadowRootsUsed` and `_rangesUsed`, start false, and are
// set the first time the feature touches a node whose node document is that document, after which the full (spec)
// code paths are always taken for that document's nodes.
//
// Scoping them per document (rather than per process) keeps one test's shadow DOM or Range use from slowing down later
// windows in the same process. The invariants the fast paths rely on are:
//
// * `_shadowRootsUsed`: if any node whose node document is D is a shadow root (so: in a shadow tree, a shadow host, a
//   slot with assigned nodes, or assigned to a slot), D's flag is set. A shadow root's node document is its host's.
// * `_rangesUsed`: if any node whose node document is D has ever been a live range boundary point, D's flag is set.
//
// A node's node document only changes through adoption, which moves its whole shadow-including subtree, so `adopt()`
// carries both flags over to the new document. That covers nodes moved between windows, out of template contents, and
// live ranges whose boundary points end up in another document. Everything in a node tree (shadow-including) shares one
// node document, so a node's own document's flag speaks for its whole tree.

exports.initDocument = document => {
  document._shadowRootsUsed = false;
  document._rangesUsed = false;
};

exports.noteShadowRoot = shadowRootImpl => {
  shadowRootImpl._ownerDocument._shadowRootsUsed = true;
};

exports.noteRangeBoundary = nodeImpl => {
  nodeImpl._ownerDocument._rangesUsed = true;
};

// Called when nodes move from `oldDocument` to `newDocument`.
exports.adopt = (oldDocument, newDocument) => {
  if (oldDocument._shadowRootsUsed) {
    newDocument._shadowRootsUsed = true;
  }
  if (oldDocument._rangesUsed) {
    newDocument._rangesUsed = true;
  }
};

// Whether `impl` (an event target, related target, or event path item, possibly null or the window proxy) could be in a
// shadow tree, a shadow host, a slot, or assigned to a slot. Nodes answer through their node document. Other values
// either have no `_ownerDocument` with the flag, or are never in a shadow tree, so a true result for them is merely
// conservative.
exports.mayBeInShadowTree = impl => {
  return impl?._ownerDocument?._shadowRootsUsed === true;
};
