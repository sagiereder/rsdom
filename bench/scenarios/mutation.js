"use strict";
// MutationObserver scenarios. Testing Library's waitFor()/findBy*() observe the container with
// { subtree, childList, attributes, characterData } and re-run the query callback on every delivery, so every
// React commit in a test pays for mutation-record creation and delivery.
const { freshDom, check } = require("../lib/common.js");
const { loadReact, renderDashboard, closeDashboard, runDashboardUpdates } = require("./react.js");

const N_SYNTH = 10000;
const ROUNDS = 4;

module.exports = [
  {
    name: "mutation/observed-updates",
    group: "mutation",
    desc: "react/updates (~50 state updates on the dashboard) with a waitFor-style MutationObserver (subtree, " +
      "childList, attributes, characterData) on the container whose callback re-runs a query",
    caveats: {
      "happy-dom": "wrong results: delivers 4974 mutation records instead of 4782 (192 extra childList records)"
    },
    prepare: ctx => loadReact(ctx),
    async setup(ctx, shared) {
      const st = renderDashboard(ctx, shared);
      await st.act(() => st.root.render(st.React.createElement(st.apps.Dashboard)));
      st.impl = ctx.impl;
      st.stats = { callbacks: 0, records: 0, text: "" };
      st.observer = new st.dom.window.MutationObserver(records => {
        st.stats.callbacks++;
        st.stats.records += records.length;
        // waitFor's checkCallback: re-run the assertion's query against the container
        st.stats.text = st.container.querySelector(".toolbar .count").textContent;
      });
      st.observer.observe(st.container, { subtree: true, childList: true, attributes: true, characterData: true });
      return st;
    },
    async run(st) {
      await runDashboardUpdates(st);
      check(st.stats.callbacks, 48, "observer callbacks (one per act() commit)", st.impl);
      check(st.stats.text, "250 users", "last observed toolbar text", st.impl);
      check(st.stats.records, { "default": 4782, "happy-dom": 4974 }, "mutation records", st.impl);
      return st.stats.records;
    },
    teardown(st) {
      st.observer.disconnect();
      return closeDashboard(st);
    }
  },
  {
    name: "mutation/synthetic-10k",
    group: "mutation",
    desc: `${ROUNDS} rounds of ${N_SYNTH} mutations (setAttribute, text.data, appendChild, removeChild) under a subtree ` +
      "observer with attributeOldValue/characterDataOldValue, each round delivered in one callback that reads every record",
    setup(ctx) {
      let html = "<div id=\"root\">";
      for (let i = 0; i < 100; i++) {
        html += `<div class="cell" data-i="${i}"><p>text ${i}</p></div>`;
      }
      const dom = freshDom(ctx, `<!DOCTYPE html><html><head></head><body>${html}</div></body></html>`);
      const root = dom.window.document.getElementById("root");
      const cells = Array.from(root.children);
      return { dom, impl: ctx.impl, root, cells, texts: cells.map(c => c.firstChild.firstChild) };
    },
    async run({ dom, impl, root, cells, texts }) {
      const { document, MutationObserver } = dom.window;
      const byType = { attributes: 0, characterData: 0, childList: 0 };
      let oldValues = 0;
      const observer = new MutationObserver(records => {
        for (const r of records) {
          byType[r.type]++;
          if (r.oldValue !== null) {
            oldValues++;
          }
          oldValues += r.addedNodes.length + r.removedNodes.length;
        }
      });
      observer.observe(root, {
        subtree: true, childList: true, attributes: true, characterData: true,
        attributeOldValue: true, characterDataOldValue: true
      });
      const added = [];
      let deliveries = 0;
      for (let round = 0; round < ROUNDS; round++) {
        for (let i = 0; i < N_SYNTH; i++) {
          const k = i % 100;
          switch (i % 4) {
            case 0: cells[k].setAttribute("data-v", `${round}.${i}`); break;
            case 1: texts[k].data = `text ${k} v${round}.${i}`; break;
            case 2: {
              const span = document.createElement("span");
              cells[k].appendChild(span);
              added.push(span);
              break;
            }
            default: {
              const span = added.pop();
              span.parentNode.removeChild(span);
            }
          }
        }
        // let the delivery microtask run
        await Promise.resolve();
        deliveries += byType.attributes + byType.characterData + byType.childList === (round + 1) * N_SYNTH ? 1 : 0;
      }
      observer.disconnect();
      check(deliveries, ROUNDS, "rounds fully delivered before the next one", impl);
      check(`${byType.attributes}/${byType.characterData}/${byType.childList}`,
        `${ROUNDS * N_SYNTH / 4}/${ROUNDS * N_SYNTH / 4}/${ROUNDS * N_SYNTH / 2}`, "records by type", impl);
      // every record carries an oldValue or one added/removed node, except the first attribute write on each of the
      // 25 cells that get attribute writes
      check(oldValues, ROUNDS * N_SYNTH - 25, "oldValues + added/removed nodes", impl);
      return oldValues;
    },
    teardown: st => st.dom.close()
  }
];
