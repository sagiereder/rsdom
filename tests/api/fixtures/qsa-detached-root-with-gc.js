"use strict";

const assert = require("node:assert/strict");
const { setImmediate } = require("node:timers/promises");
const { JSDOM } = require("../../..");

// querySelectorAll() caches a collection for the root it was called on; that must not keep the root alive once the
// page drops it.
(async () => {
  const { document } = new JSDOM().window;
  let container = document.body.appendChild(document.createElement("div"));
  container.innerHTML = `<p class="item">a</p><p class="item">b</p>`;
  assert.equal(container.querySelectorAll(".item").length, 2);
  assert.equal(container.querySelectorAll(".item").length, 2);

  const containerRef = new WeakRef(container);
  container.remove();
  container = undefined;

  let collected = false;
  for (let i = 0; i < 10; ++i) {
    await setImmediate();
    global.gc();
    if (containerRef.deref() === undefined) {
      collected = true;
      break;
    }
  }

  assert.equal(document.body.isConnected, true);
  console.log(collected ? "collected" : "retained");
})();
