"use strict";

const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const { JSDOM } = require("../../..");

// Libraries such as CSS-in-JS ones create elements through one (global) document and insert them into another. The
// first document's bookkeeping of mutations to those elements must not keep the second document alive.
function insertStyle(creatingDocument, targetDocument) {
  const style = creatingDocument.createElement("style");
  style.setAttribute("data-test", "");
  style.textContent = "p { color: red; }";
  targetDocument.head.append(style);
}

(async () => {
  const { document: globalDocument } = new JSDOM(`<p class="a"></p>`).window;
  // A live collection makes the document keep a record of its mutations.
  const live = globalDocument.getElementsByClassName("a");
  assert.equal(live.length, 1);

  let otherWindow = new JSDOM().window;
  insertStyle(globalDocument, otherWindow.document);

  const otherDocumentRef = new WeakRef(otherWindow.document);
  otherWindow.close();
  otherWindow = undefined;

  let collected = false;
  for (let i = 0; i < 10; ++i) {
    await setImmediate();
    global.gc();
    if (otherDocumentRef.deref() === undefined) {
      collected = true;
      break;
    }
  }

  // Keep the first document and its live collection reachable throughout the test.
  assert.equal(live.length, 1);
  console.log(collected ? "collected" : "retained");
})();
