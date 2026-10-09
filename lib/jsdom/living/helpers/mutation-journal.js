"use strict";

// A bounded log of the tree and attribute mutations in a document, used to update live collections incrementally
// instead of re-running their query from scratch (see HTMLCollection-impl.js).
//
// Every `_invalidateCaches()` call appends one record. Callers that know what changed pass a precise kind; any other
// call is recorded as OTHER, which forces a full rebuild of the collections whose root contains the record's node.
// A document only gets a journal once it has a collection that can use one.

const OTHER = 0;
// `node` was inserted into `target`.
const INSERT = 1;
// `node` was removed from `target`.
const REMOVE = 2;
// An attribute named `name` (in the null namespace; otherwise `name` is null) changed on `target`.
const ATTRIBUTE = 3;

// Collections that fall further behind than this are rebuilt from scratch.
const MAX_RECORDS = 256;

class MutationJournal {
  constructor() {
    // Sequence number of the first retained record.
    this.base = 0;
    this.kinds = [];
    this.targets = [];
    this.nodes = [];
    this.names = [];
  }

  get seq() {
    return this.base + this.kinds.length;
  }

  record(kind, target, node, name) {
    if (this.kinds.length === MAX_RECORDS) {
      // Drop everything: collections that have not caught up rebuild, and the dropped nodes can be collected.
      this.base += MAX_RECORDS;
      this.kinds.length = 0;
      this.targets.length = 0;
      this.nodes.length = 0;
      this.names.length = 0;
    }
    this.kinds.push(kind);
    this.targets.push(target);
    this.nodes.push(node);
    this.names.push(name);
  }
}

module.exports = { MutationJournal, OTHER, INSERT, REMOVE, ATTRIBUTE };
