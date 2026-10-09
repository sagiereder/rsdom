"use strict";
// Registry of all scenarios, in run order. Scenario contract:
//   { name, group, desc,
//     prepare?(ctx) -> shared        once per process, untimed (ctx = { JSDOM, impl })
//     setup?(ctx, shared) -> state   before every iteration, untimed (may be async)
//     run(state)                     TIMED (may be async)
//     teardown?(state)               after every iteration, untimed (may be async) }
module.exports = [
  ...require("./dom-basic.js"),
  ...require("./large.js"),
  ...require("./tables.js"),
  ...require("./selectors.js"),
  ...require("./events-style.js"),
  ...require("./react.js")
];
