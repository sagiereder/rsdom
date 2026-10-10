"use strict";
// Dynamic-style scenarios: CSS-in-JS runtimes (the real @emotion/css, which injects <style> tags in development
// and calls sheet.insertRule in production "speedy" mode while components mount) and getComputedStyle right after style mutations, as done by
// jest-dom's toBeVisible()/toHaveStyle() (jsdom #3984/#3985/#3659: style invalidation and cascade cost).
const { freshDom, installGlobals, check } = require("../lib/common.js");

const DISPLAYS = ["flex", "block", "grid", "inline-block"];
const rgb = i => `rgb(${(i * 37) % 256}, ${(i * 91) % 256}, ${(i * 53) % 256})`;

// A styled component's style object, varied per component: base declarations plus the nested rules emotion
// splits into separate CSS rules (pseudo-class, child selector, media query).
function componentStyles(i) {
  return {
    display: DISPLAYS[i % 4],
    padding: `${i % 8}px ${i % 4}px`,
    color: rgb(i),
    border: `1px solid ${rgb(i + 1)}`,
    fontSize: 12 + (i % 6),
    lineHeight: 1.5,
    boxSizing: "border-box",
    "&:hover": { color: rgb(i + 2) },
    "& > span": { marginLeft: i % 5, fontWeight: i % 2 ? 700 : 400 },
    "@media (max-width: 300px)": { padding: 8 }
  };
}

// @emotion/css is loaded once per process with a bootstrap window's globals installed (it detects the browser
// at module load); each iteration gets its own emotion instance targeting that iteration's <head>.
function loadEmotion(ctx) {
  installGlobals(freshDom(ctx).window);
  return { createEmotion: require("@emotion/css/create-instance").default };
}

// Mounts n emotion-styled components (css() + element creation), getComputedStyle-checking new elements and a
// sample of older ones every 10 mounts. Returns [reads, correct reads].
function mountStyled(window, emotion, n, perComponent) {
  const { document } = window;
  const els = [];
  let reads = 0;
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const className = emotion.css(componentStyles(i));
    for (let j = 0; j < perComponent; j++) {
      const el = document.createElement("div");
      el.className = `${className} item-${j}`;
      const span = document.createElement("span");
      span.textContent = `item ${i}.${j}`;
      el.appendChild(span);
      document.body.appendChild(el);
      els.push([i, el]);
    }
    if (i % 10 === 9) {
      const sample = els.filter(([k], idx) => k > i - 10 || idx % 17 === 0);
      for (const [k, e] of sample) {
        const cs = window.getComputedStyle(e);
        reads++;
        if (cs.display === DISPLAYS[k % 4] && cs.color === rgb(k) && cs.paddingTop === `${k % 8}px` &&
            window.getComputedStyle(e.firstChild).marginLeft === `${k % 5}px`) {
          ok++;
        }
      }
    }
  }
  return [reads, ok];
}

const N_INJECT = 200;
const N_SPEEDY = 250;

module.exports = [
  {
    name: "style/css-in-js-inject",
    group: "style",
    desc: `@emotion/css (dev mode, one <style> tag per rule): mount ${N_INJECT} components with distinct styles ` +
      "(4 rules each, ~800 <style> tags); every 10 mounts getComputedStyle on the new elements and a sample of older ones",
    prepare: loadEmotion,
    setup(ctx, { createEmotion }) {
      const dom = freshDom(ctx);
      return { dom, createEmotion, impl: ctx.impl };
    },
    run({ dom, createEmotion, impl }) {
      const { document } = dom.window;
      const emotion = createEmotion({ key: "css", container: document.head, speedy: false });
      const [reads, ok] = mountStyled(dom.window, emotion, N_INJECT, 1);
      check(document.head.querySelectorAll("style[data-emotion]").length, N_INJECT * 4, "<style> tags", impl);
      check(ok, reads, "computed display/color/padding/margin of styled elements", impl);
      return reads;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "style/css-in-js-insertRule",
    group: "style",
    desc: `@emotion/css speedy mode (production: sheet.insertRule): mount ${N_SPEEDY} components x 2 elements ` +
      `(${N_SPEEDY * 4} insertRule calls), getComputedStyle on new + sampled elements every 10 mounts`,
    prepare: loadEmotion,
    setup(ctx, { createEmotion }) {
      const dom = freshDom(ctx);
      return { dom, createEmotion, impl: ctx.impl };
    },
    run({ dom, createEmotion, impl }) {
      const { document } = dom.window;
      const emotion = createEmotion({ key: "css", container: document.head, speedy: true });
      const [reads, ok] = mountStyled(dom.window, emotion, N_SPEEDY, 2);
      const sheets = Array.from(document.head.querySelectorAll("style[data-emotion]"));
      check(sheets.reduce((n, st) => n + st.sheet.cssRules.length, 0), N_SPEEDY * 4, "inserted CSS rules", impl);
      check(ok, reads, "computed display/color/padding/margin of styled elements", impl);
      return reads;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "style/computed-after-mutation",
    group: "style",
    desc: "600x: mutate classes / inline style (border shorthand, setAttribute('style'), cssText) on a 1.5k-element " +
      "tree with a 120-rule sheet, then assert with the real jest-dom toHaveStyle() + toBeVisible() (ancestor walk)",
    caveats: {
      "happy-dom": "wrong results: 60 of 600 toHaveStyle() assertions fail (unset visibility computes to '' instead of " +
        "'visible'; `.theme-dark .card` color is missing on one card after the ancestor's class changes)"
    },
    prepare(ctx) {
      installGlobals(freshDom(ctx).window);
      return { matchers: require("@testing-library/jest-dom/matchers") };
    },
    setup(ctx, { matchers }) {
      let css = ".hidden { display: none; } .ghost { visibility: hidden; } .faded { opacity: 0; }\n" +
        ".theme-dark .card { color: rgb(240, 240, 240); background: rgb(17, 17, 17); }\n";
      for (let i = 0; i < 120; i++) {
        css += `.card.k${i % 30} .item:nth-child(${(i % 5) + 1}) { padding: ${i % 6}px; border-left: ${i % 3}px solid ${rgb(i)}; }\n`;
      }
      let body = "<div id=\"app\" class=\"theme-light\">";
      for (let s = 0; s < 30; s++) {
        body += `<section class="panel"><div class="card k${s}"><div class="body"><ul class="list">`;
        for (let i = 0; i < 10; i++) {
          body += `<li class="item"><span class="label">Item ${s}.${i}</span><em>!</em></li>`;
        }
        body += "</ul></div></div></section>";
      }
      body += "</div>";
      const dom = freshDom(ctx, `<!DOCTYPE html><html><head><style>${css}</style></head><body>${body}</body></html>`);
      installGlobals(dom.window);
      const { document } = dom.window;
      return {
        dom,
        matchers,
        impl: ctx.impl,
        app: document.getElementById("app"),
        cards: Array.from(document.querySelectorAll(".card")),
        labels: Array.from(document.querySelectorAll(".label"))
      };
    },
    run({ matchers, app, cards, labels, impl }) {
      // the `this` jest passes to matchers; only consulted when building failure messages
      const jest = { isNot: false, promise: "", equals: (a, b) => a === b, utils: {
        matcherHint: () => "", printReceived: String, printExpected: String, stringify: String,
        RECEIVED_COLOR: String, EXPECTED_COLOR: String, diff: () => ""
      } };
      const expectStyle = (el, css) => (matchers.toHaveStyle.call(jest, el, css).pass ? 1 : 0);
      let styleOk = 0;
      let visible = 0;
      for (let i = 0; i < 600; i++) {
        const card = cards[i % cards.length];
        const label = labels[(i * 7) % labels.length];
        const item = label.parentElement;
        switch (i % 6) {
          case 0:
            card.classList.toggle("hidden");
            styleOk += expectStyle(card, { display: card.classList.contains("hidden") ? "none" : "block" });
            break;
          case 1:
            item.style.border = `${(i % 4) + 1}px dashed ${rgb(i)}`;
            styleOk += expectStyle(item, { borderTopWidth: `${(i % 4) + 1}px`, borderLeftStyle: "dashed", borderBottomColor: rgb(i) });
            break;
          case 2:
            item.setAttribute("style", `padding: 1px 2px 3px; margin: 0 auto; border-top: 2px solid ${rgb(i)}`);
            styleOk += expectStyle(item, `padding-left: 2px; padding-bottom: 3px; border-top-style: solid; border-top-color: ${rgb(i)}`);
            break;
          case 3:
            label.style.cssText = `opacity: ${i % 12 ? 0.5 : 0}; display: inline-block; font: italic 12px serif`;
            styleOk += expectStyle(label, { opacity: i % 12 ? "0.5" : "0", display: "inline-block", fontStyle: "italic" });
            break;
          case 4:
            label.classList.toggle("ghost");
            styleOk += expectStyle(label, { visibility: label.classList.contains("ghost") ? "hidden" : "visible" });
            break;
          default:
            app.className = app.className === "theme-light" ? "theme-dark" : "theme-light";
            styleOk += app.className === "theme-dark" ? expectStyle(card, { color: "rgb(240, 240, 240)" }) : 1;
        }
        visible += matchers.toBeVisible.call(jest, label).pass ? 1 : 0;
      }
      check(styleOk, { "default": 600, "happy-dom": 540 }, "toHaveStyle() passes", impl);
      check(visible, 497, "toBeVisible() passes", impl);
      return visible;
    },
    teardown: st => st.dom.close()
  }
];
