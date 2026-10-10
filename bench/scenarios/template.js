"use strict";
// Template-cloning renderers (js-framework-benchmark shape). template/clone-render is the DOM code the Svelte and
// Solid compilers emit (their runtimes need a compile step, so the compiled output is written out here): parse a
// <template> once, importNode(tpl.content, true) per row, bind text nodes by firstChild/nextSibling walks, write
// text.data, insert before comment anchors. template/lit-render runs the real lit-html with the repeat() directive.
const { freshDom, rng, installGlobals, check } = require("../lib/common.js");

const N = 2000;
const N_LIT = 1000;
const ROW = "<tr><td class=\"col-md-1\"> </td><td class=\"col-md-4\"><a class=\"lbl\"> </a></td>" +
  "<td class=\"col-md-1\"><a class=\"remove\"><span class=\"glyphicon glyphicon-remove\" aria-hidden=\"true\"></span>" +
  "</a></td><td class=\"col-md-6\"><!----></td></tr>";
const ADJ = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean"];
const NOUNS = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza"];

// Walks the table body in DOM order and returns the ids, read from each row's first text node.
function readIds(tbody) {
  const ids = [];
  for (let tr = tbody.firstChild; tr; tr = tr.nextSibling) {
    if (tr.nodeType === 1) {
      ids.push(Number(tr.firstChild.firstChild.data));
    }
  }
  return ids;
}

module.exports = [
  {
    name: "template/clone-render",
    group: "template",
    desc: `<template> parsed once, ${N}x importNode(content, true) + firstChild/nextSibling binding + text.data + ` +
      "insertBefore(comment anchor); update every 10th label, select, swap, keyed shuffle via insertBefore, remove 1/7",
    setup(ctx) {
      const dom = freshDom(ctx, "<!DOCTYPE html><html><head></head><body><table class=\"table\"><tbody>" +
        "<!--anchor--></tbody></table></body></html>");
      const { document } = dom.window;
      const tbody = document.querySelector("tbody");
      return { dom, document, tbody, anchor: tbody.lastChild, impl: ctx.impl };
    },
    run({ document, tbody, anchor, impl }) {
      const rand = rng(11);
      const tpl = document.createElement("template");
      tpl.innerHTML = ROW;
      const rows = [];
      for (let id = 1; id <= N; id++) {
        const frag = document.importNode(tpl.content, true);
        const tr = frag.firstChild;
        const td1 = tr.firstChild;
        const label = td1.nextSibling.firstChild.firstChild;
        td1.firstChild.data = String(id);
        label.data = `${ADJ[id % ADJ.length]} ${NOUNS[(id * 7) % NOUNS.length]}`;
        tbody.insertBefore(frag, anchor);
        rows.push({ id, tr, label });
      }
      // update every 10th row (x2), select a few rows
      for (let rep = 0; rep < 2; rep++) {
        for (let i = 0; i < rows.length; i += 10) {
          rows[i].label.data += " !!!";
        }
      }
      for (let i = 0; i < 20; i++) {
        rows[i * 97].tr.className = i % 2 ? "danger" : "";
      }
      // swap rows 1 and 998 (Svelte/Solid keyed swap: two insertBefore calls)
      const a = rows[1].tr;
      const b = rows[998].tr;
      const afterB = b.nextSibling;
      tbody.insertBefore(b, a);
      tbody.insertBefore(a, afterB);
      [rows[1], rows[998]] = [rows[998], rows[1]];
      // keyed reorder: random permutation applied back-to-front with insertBefore(next sibling)
      const order = rows.map((r, i) => [rand(), i]).sort((x, y) => x[0] - y[0]).map(([, i]) => rows[i]);
      let next = anchor;
      for (let i = order.length - 1; i >= 0; i--) {
        if (order[i].tr.nextSibling !== next) {
          tbody.insertBefore(order[i].tr, next);
        }
        next = order[i].tr;
      }
      // remove every 7th row
      const kept = [];
      for (let i = 0; i < order.length; i++) {
        if (i % 7 === 0) {
          tbody.removeChild(order[i].tr);
        } else {
          kept.push(order[i]);
        }
      }
      const ids = readIds(tbody);
      check(ids.length, kept.length, "row count", impl);
      check(ids.every((id, i) => id === kept[i].id), true, "row order after keyed reorder", impl);
      check(tbody.lastChild === anchor, true, "anchor comment stays last", impl);
      check(rows[10].tr.querySelector(".lbl").textContent, `${rows[10].label.data}`, "label text", impl);
      return ids.length;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "template/lit-render",
    group: "template",
    desc: `real lit-html: render a keyed repeat() table of ${N_LIT} rows, update every 10th label, select a row, swap, ` +
      "shuffle, remove every 7th, append 500, clear",
    // lit-html binds to the global document when it is first imported, as in a test file whose environment is set
    // up before imports. So one window per process; each iteration renders into a fresh container.
    prepare(ctx) {
      const dom = freshDom(ctx);
      installGlobals(dom.window);
      const { html, render } = require("lit");
      const { repeat } = require("lit/directives/repeat.js");
      return { dom, html, render, repeat };
    },
    setup(ctx, shared) {
      const { document } = shared.dom.window;
      const container = document.createElement("div");
      document.body.appendChild(container);
      return { ...shared, container, impl: ctx.impl };
    },
    run({ html, render, repeat, container, impl }) {
      const rand = rng(23);
      let nextId = 1;
      const build = n => Array.from({ length: n }, () => {
        const id = nextId++;
        return { id, label: `${ADJ[(id * 3) % ADJ.length]} ${NOUNS[(id * 5) % NOUNS.length]}` };
      });
      let selected = 0;
      const clicks = { n: 0 };
      const app = rows => html`<div class="container"><table class="table table-hover table-striped test-data"><tbody>${
        repeat(rows, r => r.id, r => html`<tr class=${r.id === selected ? "danger" : ""}>
          <td class="col-md-1">${r.id}</td>
          <td class="col-md-4"><a @click=${() => clicks.n++}>${r.label}</a></td>
          <td class="col-md-1"><a><span class="glyphicon glyphicon-remove" aria-hidden="true"></span></a></td>
          <td class="col-md-6"></td></tr>`)}</tbody></table></div>`;
      let rows = build(N_LIT);
      render(app(rows), container);
      rows = rows.map((r, i) => (i % 10 ? r : { ...r, label: `${r.label} !!!` }));
      render(app(rows), container);
      selected = rows[5].id;
      render(app(rows), container);
      check(container.querySelector("tr.danger").firstElementChild.textContent, String(selected), "selected row", impl);
      rows = rows.slice();
      [rows[1], rows[998]] = [rows[998], rows[1]];
      render(app(rows), container);
      rows = rows.map(r => [rand(), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
      render(app(rows), container);
      rows = rows.filter((_, i) => i % 7);
      selected = rows[5].id;
      render(app(rows), container);
      rows = rows.concat(build(500));
      render(app(rows), container);
      const trs = container.querySelectorAll("tbody > tr");
      check(trs.length, rows.length, "row count", impl);
      check(Array.from(trs).every((tr, i) => Number(tr.firstElementChild.textContent) === rows[i].id), true, "row order", impl);
      check(container.querySelector("tr.danger").firstElementChild.textContent, String(selected), "selected row", impl);
      trs[3].querySelector("a").click();
      check(clicks.n, 1, "event binding", impl);
      const n = trs.length;
      render(app([]), container);
      check(container.querySelectorAll("tr").length, 0, "cleared", impl);
      return n;
    },
    teardown(st) {
      st.container.remove();
    }
  }
];
