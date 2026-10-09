"use strict";
// Event dispatch and CSS style scenarios.
const { freshDom } = require("../lib/common.js");

const DEPTH = 40;

function deepTree(document) {
  let parent = document.body;
  const chain = [];
  for (let d = 0; d < DEPTH; d++) {
    const el = document.createElement(d % 3 ? "div" : "section");
    el.className = `lvl lvl-${d}`;
    parent.appendChild(el);
    // siblings make the tree wider without affecting the propagation path
    for (let k = 0; k < 3; k++) {
      parent.appendChild(document.createElement("span"));
    }
    chain.push(el);
    parent = el;
  }
  const button = document.createElement("button");
  button.textContent = "Click";
  parent.appendChild(button);
  return { chain, button };
}

function genStylesheet() {
  const colors = ["red", "#336699", "rgb(10, 20, 30)", "hsl(120 50% 50%)", "rebeccapurple", "rgba(0,0,0,.5)"];
  let css = "";
  for (let i = 0; i < 200; i++) {
    const sel = [
      `.c${i % 50}`,
      `div.c${i % 50} > span`,
      `#root .row:nth-child(${(i % 7) + 1}) .c${i % 50}`,
      `section [data-k="${i % 13}"]`,
      `.row.c${i % 50}:hover`
    ][i % 5];
    css += `${sel} { color: ${colors[i % colors.length]}; margin: ${i % 9}px ${i % 4}em; ` +
      `display: ${i % 4 ? "block" : "flex"}; font-size: ${10 + (i % 8)}px; ` +
      `border: 1px solid ${colors[(i + 1) % colors.length]}; padding-left: calc(${i % 5}px + 1em); }\n`;
  }
  return css;
}

module.exports = [
  {
    name: "events/bubble-deep",
    group: "events",
    desc: `dispatch 4000 bubbling click events through a ${DEPTH}-deep tree with capture+bubble listeners on every level`,
    setup({ JSDOM }) {
      const dom = freshDom(JSDOM);
      const { document, MouseEvent, Event } = dom.window;
      const { chain, button } = deepTree(document);
      const counter = { n: 0 };
      for (const el of chain) {
        el.addEventListener("click", () => counter.n++, true);
        el.addEventListener("click", e => {
          counter.n += e.eventPhase;
        });
        el.addEventListener("input", () => counter.n++);
      }
      document.addEventListener("click", e => {
        if (e.target.closest) {
          counter.n++;
        }
      });
      return { dom, button, counter, MouseEvent, Event };
    },
    run({ button, counter, MouseEvent, Event }) {
      for (let i = 0; i < 4000; i++) {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: i }));
        if (i % 4 === 0) {
          button.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      return counter.n;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "events/many-targets-delegation",
    group: "events",
    desc: "React-style root delegation: 750 elements each get click() + focus(), root listener inspects target",
    setup({ JSDOM }) {
      const dom = freshDom(JSDOM);
      const { document } = dom.window;
      const root = document.createElement("div");
      document.body.appendChild(root);
      let html = "";
      for (let i = 0; i < 250; i++) {
        html += `<div class="row"><button data-i="${i}">B${i}</button><input value="${i}"><a href="#x">x</a></div>`;
      }
      root.innerHTML = html;
      const counter = { n: 0 };
      for (const type of ["click", "focusin", "focusout"]) {
        root.addEventListener(type, e => {
          counter.n += e.target.tagName.length;
        });
        root.addEventListener(type, () => counter.n++, true);
      }
      return { dom, root, counter, targets: Array.from(root.querySelectorAll("button, input, a")) };
    },
    run({ targets, counter }) {
      for (const el of targets) {
        el.click();
        el.focus();
      }
      return counter.n;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "style/inline-set",
    group: "style",
    desc: "React-style inline style writes: 3000 elements x 10 properties (style.x=, setProperty, cssText read)",
    setup({ JSDOM }) {
      const dom = freshDom(JSDOM);
      const { document } = dom.window;
      const els = [];
      for (let i = 0; i < 3000; i++) {
        const el = document.createElement("div");
        document.body.appendChild(el);
        els.push(el);
      }
      return { dom, els };
    },
    run({ els }) {
      let n = 0;
      for (let i = 0; i < els.length; i++) {
        const { style } = els[i];
        style.display = i % 2 ? "flex" : "block";
        style.width = `${i % 300}px`;
        style.height = "24px";
        style.marginTop = `${i % 10}px`;
        style.padding = "4px 8px";
        style.color = i % 3 ? "#333" : "rgb(200, 10, 10)";
        style.backgroundColor = "rgba(0, 0, 0, 0.05)";
        style.setProperty("border", "1px solid #ccc");
        style.setProperty("--custom-var", String(i));
        style.transform = `translateX(${i % 50}px)`;
        n += style.cssText.length;
      }
      return n;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "style/computed-style",
    group: "style",
    desc: "getComputedStyle on 1500 elements with a 200-rule stylesheet, reading 6 properties each",
    setup({ JSDOM }) {
      let body = "<div id=\"root\">";
      for (let r = 0; r < 300; r++) {
        body += `<section class="row c${r % 50}" data-k="${r % 13}">`;
        for (let k = 0; k < 4; k++) {
          body += `<div class="c${(r + k) % 50}"><span data-k="${k}">t</span></div>`;
        }
        body += "</section>";
      }
      body += "</div>";
      const dom = freshDom(JSDOM, `<!DOCTYPE html><html><head><style>${genStylesheet()}</style></head><body>${body}</body></html>`);
      const els = Array.from(dom.window.document.querySelectorAll("#root *")).slice(0, 1500);
      return { dom, els };
    },
    run({ dom, els }) {
      let n = 0;
      for (const el of els) {
        const cs = dom.window.getComputedStyle(el);
        n += cs.color.length + cs.display.length + cs.fontSize.length + cs.marginTop.length +
          cs.visibility.length + cs.getPropertyValue("padding-left").length;
      }
      return n;
    },
    teardown: st => st.dom.window.close()
  }
];
