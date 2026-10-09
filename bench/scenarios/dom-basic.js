"use strict";
// Simple divs and ul/li lists.
const { freshDom } = require("../lib/common.js");

const N_DIVS = 20000;
const N_LI = 10000;

function divsHtml(n) {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += `<div class="item item-${i % 10}" id="d${i}">Item number ${i}</div>`;
  }
  return s;
}

function liHtml(n) {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += `<li class="entry${i % 3 === 0 ? " odd" : ""}" data-index="${i}">List entry ${i}</li>`;
  }
  return s;
}

const domSetup = ({ JSDOM }) => {
  const dom = freshDom(JSDOM);
  return { dom, document: dom.window.document };
};
const domTeardown = st => st.dom.window.close();

module.exports = [
  {
    name: "divs/create-dom-api",
    group: "divs",
    desc: `create ${N_DIVS} divs via createElement + className + textContent + appendChild`,
    setup: domSetup,
    run({ document }) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      for (let i = 0; i < N_DIVS; i++) {
        const div = document.createElement("div");
        div.className = `item item-${i % 10}`;
        div.textContent = `Item number ${i}`;
        container.appendChild(div);
      }
    },
    teardown: domTeardown
  },
  {
    name: "divs/innerHTML",
    group: "divs",
    desc: `set innerHTML with ${N_DIVS} divs, read back childElementCount`,
    prepare: () => ({ html: divsHtml(N_DIVS) }),
    setup: (ctx, shared) => ({ ...domSetup(ctx), html: shared.html }),
    run({ document, html }) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      container.innerHTML = html;
      if (container.childElementCount !== N_DIVS) {
        throw new Error("bad count");
      }
    },
    teardown: domTeardown
  },
  {
    name: "lists/create-dom-api",
    group: "lists",
    desc: `create ul with ${N_LI} li via DOM API (setAttribute, classList, append text)`,
    setup: domSetup,
    run({ document }) {
      const ul = document.createElement("ul");
      document.body.appendChild(ul);
      for (let i = 0; i < N_LI; i++) {
        const li = document.createElement("li");
        li.setAttribute("data-index", String(i));
        li.classList.add("entry");
        if (i % 3 === 0) {
          li.classList.add("odd");
        }
        li.append(`List entry ${i}`);
        ul.appendChild(li);
      }
    },
    teardown: domTeardown
  },
  {
    name: "lists/innerHTML",
    group: "lists",
    desc: `ul.innerHTML with ${N_LI} li`,
    prepare: () => ({ html: liHtml(N_LI) }),
    setup: (ctx, shared) => ({ ...domSetup(ctx), html: shared.html }),
    run({ document, html }) {
      const ul = document.createElement("ul");
      document.body.appendChild(ul);
      ul.innerHTML = html;
    },
    teardown: domTeardown
  },
  {
    name: "lists/query-iterate-read",
    group: "lists",
    desc: `on a ${N_LI}-li list: querySelectorAll('li'), children/sibling iteration, textContent + dataset reads (x5)`,
    prepare: () => ({ html: liHtml(N_LI) }),
    setup(ctx, shared) {
      const st = domSetup(ctx);
      st.document.body.innerHTML = `<ul id="list">${shared.html}</ul>`;
      return st;
    },
    run({ document }) {
      let total = 0;
      for (let rep = 0; rep < 5; rep++) {
        const lis = document.querySelectorAll("li");
        for (let i = 0; i < lis.length; i++) {
          total += lis[i].textContent.length;
        }
        const ul = document.getElementById("list");
        const { children } = ul;
        for (let i = 0; i < children.length; i++) {
          total += children[i].dataset.index.length;
        }
        for (let el = ul.firstElementChild; el; el = el.nextElementSibling) {
          if (el.classList.contains("odd")) {
            total++;
          }
        }
        total += document.querySelectorAll("li.odd").length;
        total += ul.textContent.length;
      }
      return total;
    },
    teardown: domTeardown
  }
];
