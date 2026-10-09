"use strict";
// Selector matching on a large app-like tree.
const { freshDom, rng } = require("../lib/common.js");

// ~20 sections x 25 cards x ~12 elements => ~6k elements + text.
function appHtml() {
  const rand = rng(3);
  let s = "<div id=\"app\" class=\"app theme-light\"><header class=\"top\"><nav><ul class=\"menu\">";
  for (let i = 0; i < 20; i++) {
    s += `<li class="menu-item${i === 3 ? " active" : ""}"><a href="/p/${i}" class="link">Page ${i}</a></li>`;
  }
  s += "</ul></nav></header><main>";
  for (let sct = 0; sct < 20; sct++) {
    s += `<section class="panel" data-kind="${["news", "stats", "users", "logs"][sct % 4]}" id="s${sct}">`;
    s += `<h2 class="panel-title">Section ${sct}</h2><div class="cards">`;
    for (let c = 0; c < 25; c++) {
      const disabled = rand() < 0.2;
      s += `<article class="card${disabled ? " disabled" : ""}" data-id="${sct * 25 + c}" lang="${c % 5 ? "en" : "fr"}">` +
        `<div class="card-head"><h3 class="title">Card ${c}</h3><span class="badge b${c % 4}">${c}</span></div>` +
        "<ul class=\"items\">" +
        `<li class="item">a</li><li class="item${c % 2 ? " hot" : ""}">b</li><li class="item">c</li>` +
        "</ul>" +
        `<p class="desc">Description <a href="https://example.com/${c}" class="ext" target="_blank">more</a></p>` +
        `<input type="checkbox" name="sel${c}"${c % 3 ? "" : " checked"}><button type="button" class="btn${c % 6 ? "" : " primary"}">Go</button>` +
        "</article>";
    }
    s += "</div></section>";
  }
  return `${s}</main><footer class="foot"><p>Footer</p></footer></div>`;
}

const COMPLEX = [
  "section[data-kind='stats'] article.card:not(.disabled) .items > li.item.hot",
  "main > section:nth-of-type(2n+1) .card-head h3.title",
  "article.card:has(> input:checked) .badge",
  "a[href^='https://'][target=_blank]",
  ".cards article:nth-child(5n) ~ article:last-child",
  "ul.menu li.active + li a.link",
  "article:is([lang|=fr], .disabled) button.btn",
  "section .card :where(.badge, .title):not(.b0)",
  "input[type=checkbox]:not(:checked) + button.primary",
  "#app main section:first-child article:first-of-type li:nth-last-child(2)",
  "*:not(div):not(span):not(li)",
  "button:enabled",
  "p.desc a.ext",
  ".panel > .cards > .card > .card-head > .badge.b3"
];

function setup({ JSDOM }, { html }) {
  const dom = freshDom(JSDOM, `<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  return { dom, document: dom.window.document };
}
const teardown = st => st.dom.window.close();
const prepare = () => ({ html: appHtml() });

module.exports = [
  {
    name: "selectors/complex-qsa",
    group: "selectors",
    desc: `${COMPLEX.length} complex selectors via document.querySelectorAll on ~8k-element tree (x2)`,
    prepare,
    setup,
    run({ document }) {
      let n = 0;
      for (let rep = 0; rep < 2; rep++) {
        for (const sel of COMPLEX) {
          n += document.querySelectorAll(sel).length;
        }
      }
      return n;
    },
    teardown
  },
  {
    name: "selectors/querySelector-many",
    group: "selectors",
    desc: "2000 querySelector calls (attr/id/class lookups) + scoped element.querySelector",
    prepare,
    setup,
    run({ document }) {
      let n = 0;
      for (let i = 0; i < 500; i++) {
        if (document.querySelector(`[data-id="${(i * 7) % 500}"]`)) {
          n++;
        }
        if (document.querySelector(`#s${i % 20} .card .title`)) {
          n++;
        }
        const sec = document.getElementById(`s${i % 20}`);
        if (sec.querySelector("article.disabled .badge")) {
          n++;
        }
        if (sec.querySelector(".btn.primary")) {
          n++;
        }
      }
      return n;
    },
    teardown
  },
  {
    name: "selectors/live-collections",
    group: "selectors",
    desc: "getElementsByClassName/TagName iteration interleaved with DOM mutations (cache invalidation)",
    prepare,
    setup,
    run({ document }) {
      let n = 0;
      const cards = document.getElementsByClassName("card");
      const lis = document.getElementsByTagName("li");
      const hot = document.getElementsByClassName("item hot");
      const main = document.querySelector("main");
      for (let rep = 0; rep < 50; rep++) {
        for (let i = 0; i < cards.length; i += 3) {
          n += cards[i].childElementCount;
        }
        for (let i = 0; i < lis.length; i += 5) {
          n += lis[i].className.length;
        }
        n += hot.length;
        const extra = document.createElement("li");
        extra.className = "item hot";
        main.appendChild(extra);
      }
      return n;
    },
    teardown
  },
  {
    name: "selectors/matches-closest",
    group: "selectors",
    desc: "matches() + closest() for every li/a/button element (event-delegation style)",
    prepare,
    setup(ctx, shared) {
      const st = setup(ctx, shared);
      st.targets = Array.from(st.document.querySelectorAll("li, a, button, .badge"));
      return st;
    },
    run({ targets }) {
      let n = 0;
      for (let rep = 0; rep < 2; rep++) {
        for (const el of targets) {
          if (el.matches(".card:not(.disabled) .item, .card .btn.primary")) {
            n++;
          }
          if (el.closest("section[data-kind='users']")) {
            n++;
          }
          if (el.closest("article.card")) {
            n++;
          }
        }
      }
      return n;
    },
    teardown
  }
];
