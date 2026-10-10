"use strict";
// Registry of all scenarios, in run order. Scenario contract:
//   { name, group, desc,
//     prepare?(ctx) -> shared        once per process, untimed (ctx = { impl, createDom })
//     setup?(ctx, shared) -> state   before every iteration, untimed (may be async)
//     run(state)                     TIMED (may be async)
//     teardown?(state)               after every iteration, untimed (may be async)
//     unsupported?: { [impl]: reason } impls this scenario cannot run on; reported as N/A with the reason
//     caveats?: { [impl]: note }     impls that run but diverge from jsdom (wrong results, less work); printed }
// ctx.createDom(html, opts) returns { window, serialize(), close() } for any impl (see lib/impls.js), so scenarios
// must not touch impl-specific APIs (JSDOM, happy-dom Window) directly.
module.exports = [
  ...require("./dom-basic.js"),
  ...require("./large.js"),
  ...require("./tables.js"),
  ...require("./selectors.js"),
  ...require("./events-style.js"),
  ...require("./react.js"),
  ...require("./a11y.js"),
  ...require("./style-dynamic.js"),
  ...require("./webcomponents.js"),
  ...require("./mutation.js"),
  ...require("./template.js"),
  ...require("./forms.js"),
  ...require("./startup.js"),
  ...require("./real-page.js"),
  ...require("./xml.js")
];
