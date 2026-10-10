"use strict";

const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const { JSDOM } = require("../../..");

// The collection querySelectorAll() caches for a root lists the matching elements; once they are removed from that
// root, the cache must not keep them alive.
(async () => {
  const { document } = new JSDOM().window;
  const parent = document.body.appendChild(document.createElement("div"));
  let child = parent.appendChild(document.createElement("section"));
  child.className = "item";
  child.innerHTML = "<p>content</p>".repeat(10);
  assert.equal(parent.querySelectorAll(".item").length, 1);
  assert.equal(parent.querySelectorAll(".item").length, 1);

  const childRef = new WeakRef(child);
  child.remove();
  child = undefined;

  let collected = false;
  for (let i = 0; i < 10; ++i) {
    await setImmediate();
    global.gc();
    if (childRef.deref() === undefined) {
      collected = true;
      break;
    }
  }

  // Keep the parent reachable throughout the test.
  assert.equal(parent.isConnected, true);
  console.log(collected ? "collected" : "retained");
})();
