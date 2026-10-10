"use strict";
// Window creation/teardown cost. Test runners (jest-environment-jsdom, Vitest's jsdom/happy-dom environments) create
// a fresh window per test file, and many suites create one per test, so this is paid hundreds of times per run.
const { check } = require("../lib/common.js");

const N = 200;

module.exports = [
  {
    name: "startup/window-per-test",
    group: "startup",
    desc: `${N}x create an empty window (new JSDOM('') / happy-dom new Window()), touch document.body, close it`,
    setup: ctx => ({ createDom: ctx.createDom, impl: ctx.impl }),
    async run({ createDom, impl }) {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        const dom = createDom("");
        const { document } = dom.window;
        document.body.appendChild(document.createElement("div")).id = `t${i}`;
        ok += document.getElementById(`t${i}`) ? 1 : 0;
        await dom.close();
      }
      check(ok, N, "windows created", impl);
      return ok;
    }
  },
  {
    name: "startup/window-per-test-scripts",
    group: "startup",
    desc: `${N}x create a test-environment-style window (runScripts: 'outside-only', pretendToBeVisual, url), ` +
      "evaluate a snippet with window.eval, close it",
    setup: ctx => ({ createDom: ctx.createDom, impl: ctx.impl }),
    async run({ createDom, impl }) {
      let ok = 0;
      for (let i = 0; i < N; i++) {
        const dom = createDom("<!DOCTYPE html>", { runScripts: "outside-only", pretendToBeVisual: true, url: `http://localhost:${3000 + (i % 10)}/` });
        const result = dom.window.eval(`document.title = "test ${i}"; location.port + "|" + typeof window.requestAnimationFrame`);
        ok += result === `${3000 + (i % 10)}|function` && dom.window.document.title === `test ${i}` ? 1 : 0;
        await dom.close();
      }
      check(ok, N, "windows that evaluated the snippet", impl);
      return ok;
    }
  }
];
