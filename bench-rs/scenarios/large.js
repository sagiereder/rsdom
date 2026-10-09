"use strict";
// Large nested + wide div trees: parse (fragment + full document), serialize, clone.
const { freshDom } = require("../lib/common.js");

// Branching 6, depth 5 => 1+6+36+216+1296+7776 = 9331 divs; each leaf has 4 inline children + text,
// giving roughly 50k nodes in total.
const BRANCH = 6;
const DEPTH = 5;

function buildTree(depth, path) {
  if (depth === DEPTH) {
    return `<div class="leaf l${path.length % 7}" data-path="${path}">` +
      `<span class="label">Leaf ${path}</span> <b>bold</b> <a href="#${path}" title="link ${path}">link</a>` +
      `<em>e</em></div>`;
  }
  let s = `<div class="node depth-${depth}" id="n${path || "root"}" data-depth="${depth}">`;
  for (let i = 0; i < BRANCH; i++) {
    s += buildTree(depth + 1, path + i);
  }
  return s + "</div>";
}

const treeHtml = () => buildTree(0, "");
const fullDocument = html => `<!DOCTYPE html><html><head><title>Large</title></head><body>${html}</body></html>`;

module.exports = [
  {
    name: "large/innerHTML-parse",
    group: "large",
    desc: "parse ~50k-node nested/wide tree via innerHTML",
    prepare: () => ({ html: treeHtml() }),
    setup: ({ JSDOM }, { html }) => ({ dom: freshDom(JSDOM), html }),
    run({ dom, html }) {
      dom.window.document.body.innerHTML = html;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "large/jsdom-full-parse",
    group: "large",
    desc: "new JSDOM(html) with ~50k-node body",
    prepare: () => ({ html: fullDocument(treeHtml()) }),
    setup: ({ JSDOM }, { html }) => ({ JSDOM, html }),
    run(st) {
      st.dom = new st.JSDOM(st.html);
    },
    teardown: st => st.dom && st.dom.window.close()
  },
  {
    name: "large/serialize-outerHTML",
    group: "large",
    desc: "body.outerHTML of ~50k-node tree (x4)",
    prepare: () => ({ html: fullDocument(treeHtml()) }),
    setup: ({ JSDOM }, { html }) => ({ dom: new JSDOM(html) }),
    run({ dom }) {
      const { body } = dom.window.document;
      return body.outerHTML.length + body.innerHTML.length + body.outerHTML.length + body.innerHTML.length;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "large/serialize-dom",
    group: "large",
    desc: "dom.serialize() of ~50k-node document (x4)",
    prepare: () => ({ html: fullDocument(treeHtml()) }),
    setup: ({ JSDOM }, { html }) => ({ dom: new JSDOM(html) }),
    run({ dom }) {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        n += dom.serialize().length;
      }
      return n;
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "large/cloneNode-deep",
    group: "large",
    desc: "cloneNode(true) of ~50k-node tree and append it",
    prepare: () => ({ html: fullDocument(treeHtml()) }),
    setup: ({ JSDOM }, { html }) => ({ dom: new JSDOM(html) }),
    run({ dom }) {
      const { document } = dom.window;
      const root = document.getElementById("nroot");
      const clone = root.cloneNode(true);
      document.body.appendChild(clone);
    },
    teardown: st => st.dom.window.close()
  }
];
