"use strict";

// Process-wide, monotonic flags that let hot tree-mutation paths skip work that can only matter once a feature has
// been used. Each flag starts false and is set to true the first time the feature is used in any document, after
// which the full (spec) code paths are always taken. Keeping the flags process-wide (rather than per document) keeps
// them correct when nodes are adopted between documents.
module.exports = {
  // A ShadowRoot has been created. Until then no node is in a shadow tree, so the shadow-including root of every node
  // is its root, slots never have assigned nodes, and no node is assigned to a slot.
  shadowRoots: false,

  // A Range has referenced a node as a boundary point. Until then no node has live ranges to update.
  ranges: false
};
