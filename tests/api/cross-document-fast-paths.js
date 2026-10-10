"use strict";
const assert = require("node:assert/strict");
const { describe, it } = require("mocha-sugar-free");

const { JSDOM } = require("../..");

// Shadow DOM and Range bookkeeping is skipped for documents that have never used those features. These cover nodes and
// related targets that carry that state from one document (or window) into a fresh one.
function freshWindow() {
  return new JSDOM(`<body><div id="t"></div>`).window;
}

describe("Fast paths across documents", () => {
  it("keeps shadow trees working after their host is adopted into a fresh window", () => {
    const a = freshWindow();
    const b = freshWindow();
    const host = a.document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = "<p><slot></slot></p>";
    const inner = shadowRoot.querySelector("p");

    b.document.body.append(host);
    assert.equal(inner.isConnected, true);

    const span = b.document.createElement("span");
    host.append(span);
    assert.equal(span.assignedSlot, shadowRoot.querySelector("slot"));

    const seen = [];
    b.document.body.addEventListener("click", e => seen.push(e.target.localName, e.composedPath().length));
    inner.dispatchEvent(new b.MouseEvent("click", { bubbles: true, composed: true }));
    span.dispatchEvent(new b.MouseEvent("click", { bubbles: true, composed: true }));
    assert.deepEqual(seen, ["div", 7, "span", 9]);

    host.remove();
    assert.equal(inner.isConnected, false);
    b.document.body.append(host);
    assert.equal(inner.isConnected, true);
  });

  it("keeps shadow trees created in template contents working once moved out", () => {
    const a = freshWindow();
    const template = a.document.createElement("template");
    const host = a.document.createElement("div");
    template.content.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = "<slot></slot><em></em>";
    host.append(a.document.createElement("span"));

    a.document.body.append(template.content);
    assert.equal(shadowRoot.lastChild.isConnected, true);

    const b = freshWindow();
    b.document.body.append(host);
    assert.equal(shadowRoot.lastChild.isConnected, true);
    assert.notEqual(host.firstChild.assignedSlot, null);

    const seen = [];
    b.document.addEventListener("focusin", e => seen.push(e.target.localName), true);
    shadowRoot.lastChild.dispatchEvent(new b.FocusEvent("focusin", { bubbles: true, composed: true }));
    assert.deepEqual(seen, ["div"]);
  });

  it("retargets a related target in another window's shadow tree", () => {
    const a = freshWindow();
    const b = freshWindow();
    const host = a.document.createElement("div");
    a.document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "closed" });
    shadowRoot.innerHTML = "<i></i>";

    const seen = [];
    const target = b.document.getElementById("t");
    target.addEventListener("mouseover", e => seen.push(e.relatedTarget.localName));
    b.addEventListener("mouseover", e => seen.push(e.relatedTarget.localName));
    target.dispatchEvent(new b.MouseEvent("mouseover", { bubbles: true, relatedTarget: shadowRoot.firstChild }));
    b.dispatchEvent(new b.MouseEvent("mouseover", { relatedTarget: shadowRoot.firstChild }));
    assert.deepEqual(seen, ["div", "div", "div"]);
  });

  it("updates live ranges whose boundary points were adopted into a fresh window", () => {
    const a = freshWindow();
    const b = freshWindow();
    const box = a.document.createElement("div");
    box.innerHTML = "<b>1</b><b>2</b><b>3</b>";
    const range = a.document.createRange();
    range.setStart(box.childNodes[2].firstChild, 0);
    range.setEnd(box.childNodes[2], 1);

    b.document.body.append(box);
    box.childNodes[2].remove();
    assert.equal(range.startContainer, box);
    assert.equal(range.startOffset, 2);
    assert.equal(range.endContainer, box);
    assert.equal(range.endOffset, 2);
  });
});
