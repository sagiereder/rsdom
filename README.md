# rsdom

rsdom is a drop-in fork of [jsdom](https://github.com/jsdom/jsdom) with a Rust core for its hot paths. It keeps jsdom 30.1.2's public API, so `const { JSDOM } = require("@rsdom/core")` works wherever `require("jsdom")` did. The same test suite passes: the jsdom API tests, the ported legacy tests, and every web-platform-test that jsdom 30.1.2 runs.

For the API itself (`new JSDOM()`, options, `runScripts`, resource loading, virtual consoles and so on), see the upstream documentation in [docs/jsdom-api.md](docs/jsdom-api.md). Everything there applies to rsdom.

## Why

jsdom is the DOM behind most JavaScript test runners (Jest, Vitest and Testing Library) and a lot of server-side rendering and scraping code. In those workloads, the time goes into parsing HTML, running selectors, dispatching events and computing styles, again and again. rsdom makes those paths faster without changing behaviour, so test suites and SSR pipelines speed up with no code changes.

## How it works

- **Native HTML parsing.** HTML is parsed by [html5ever](https://github.com/servo/html5ever), which is vendored and patched for exact parse5 parity, inside a napi-rs addon (`src/native/`). The addon emits a compact instruction stream. JavaScript (`src/jsdom/browser/parser/html-native.js`) replays that stream to build ordinary jsdom nodes, so the resulting tree is the same object model jsdom always had.
- **Pure-JS fallback.** Set `JSDOM_NATIVE=0`, or run without a built addon, and rsdom uses the original parse5 (HTML) and saxes (XML) paths. The test suite passes in both modes.
- **Fast selector engine.** `querySelector(All)`, `matches` and `closest` use a compiled, cached selector matcher (`src/jsdom/living/helpers/selectors/`) that supports `:has()`, falling back to the general engine only for rare cases.
- **CSS cascade caches.** Parsed stylesheet ASTs, declaration blocks and media query results are cached, so `getComputedStyle` no longer re-parses and re-matches every rule on every call.
- **Incremental live collections.** `getElementsBy*`, `children` and similar live `HTMLCollection`s are invalidated by a mutation journal and updated incrementally instead of being rebuilt after every DOM change. ID lookups go through a cache.
- **Cheaper bookkeeping.** Event dispatch has a fast path for trees without shadow roots and uses copy-on-write listener lists. Serialization is faster, wrappers are created lazily, and legacy platform-object proxies are cheaper.

## Install

```sh
npm install @rsdom/core
```

```js
const { JSDOM } = require("@rsdom/core");
```

npm also installs the prebuilt addon for your platform: macOS (arm64 or x64), Linux (x64 or arm64 with glibc, or x64 with musl) or Windows (x64). It comes from a package such as `@rsdom/core-darwin-arm64`, which `@rsdom/core` lists as an optional dependency. On other platforms, or with `--omit=optional`, rsdom runs on its pure-JS paths and behaves the same, just slower.

## Use with Jest / Vitest

rsdom ships test environments that mirror `jest-environment-jsdom` and Vitest's built-in `jsdom` environment. Switching only takes a config change. Testing Library, user-event and fake timers work as they do with jsdom.

### Jest

```sh
npm install --save-dev @rsdom/jest
```

```js
// jest.config.js
module.exports = {
  testEnvironment: "@rsdom/jest",
  // Optional, same as with jest-environment-jsdom: html, url, userAgent, customExportConditions,
  // or any JSDOM constructor option.
  testEnvironmentOptions: { url: "http://localhost/" }
};
```

`@rsdom/jest` depends on `@rsdom/core` and on the Jest packages it needs, so it works under every package manager. A per-file `/** @jest-environment @rsdom/jest */` docblock works too. `@rsdom/core` also has the environment built in as `testEnvironment: "@rsdom/core/jest"`, which uses the `jest-util`, `jest-mock` and `@jest/fake-timers` that come with Jest. That only works when your package manager hoists them (npm, or Yarn's `node_modules` linker).

### Vitest

```sh
npm install --save-dev vitest-environment-rsdom
```

```js
// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "rsdom",
    // Optional, the same options as Vitest's jsdom environment. `environmentOptions.jsdom` is read too.
    environmentOptions: { rsdom: { url: "http://localhost:3000" } }
  }
});
```

A per-file `// @vitest-environment rsdom` comment works too. All pools are supported, including `vmThreads` and `vmForks`.

The same environment is published as `@rsdom/vitest`. Vitest resolves a name that isn't built in only as the package `vitest-environment-<name>`, so the scoped package has to be given as a path: `environment: "./node_modules/@rsdom/vitest"`. Without either package, point at the copy inside `@rsdom/core`: `environment: "./node_modules/@rsdom/core/src/integrations/vitest.js"`.

## Build from source

You need Node.js (^22.22.2, ^24.15.0 or >=26) and a [Rust toolchain](https://rustup.rs/) (stable).

```sh
npm install
npm run prepare            # generates the Web IDL wrappers into src/generated
node src/native/build.js   # builds the addon to src/native/jsdom-native.node (pass --debug for a debug build)
```

If the addon is missing or fails to load, rsdom falls back to the pure-JS paths.

## Running tests

The web-platform-tests live in a git submodule (`tests/web-platform-tests/tests`). Run `npm run wpt:init` once, and set up your hosts file as the [WPT docs](https://web-platform-tests.org/running-tests/from-local-system.html#system-setup) describe.

```sh
node scripts/dev/test.js            # tests relevant to files changed vs. the rust branch
node scripts/dev/test.js --all      # the whole suite, sharded across CPUs
node scripts/dev/test.js --wpt dom/nodes,html/syntax
node scripts/dev/test.js --api
JSDOM_NATIVE=0 node scripts/dev/test.js --all   # the pure-JS fallback
```

The upstream npm scripts (`npm run test:api`, `test:wpt`, `test:tuwpt`, `test:to-port-to-wpts`) still work. See [tests/README.md](tests/README.md).

## Running benchmarks

The benchmarks in `bench/` compare rsdom with the published jsdom 30.1.2 and [happy-dom](https://github.com/capricorn86/happy-dom). Each implementation and scenario runs in a fresh process. The scenarios cover simple divs and lists, large documents, huge tables, selectors, events, styles, and React apps (a dashboard and a complex multi-page app with forms, tables and modals, plus Testing Library, using React's development builds as Jest and Vitest do).

```sh
cd bench && npm install
node run.js --stat min              # jsdom vs rsdom vs happy-dom, the run behind the table below; writes results/<timestamp>.json
node run.js --mode upstream         # jsdom vs rsdom only
node run.js --mode happy            # happy-dom vs rsdom
node run.js --quick --filter selectors
node run.js --mode native           # rsdom with JSDOM_NATIVE=0 vs rsdom
node report.js                      # rewrite the table below from the newest results file
```

Each scenario runs 3 warmups and up to 10 timed iterations within a 15-second budget per implementation (covering setup and warmups; at least 1 warmup and 3 timed iterations always run), and memory is read on the first 3 timed iterations. A full run takes about 40 minutes; `--quick` takes a few minutes.

## Benchmark results

Across all scenarios rsdom is **4.3x faster than jsdom** and **3.7x faster than happy-dom** (geometric mean), with the biggest gains on selectors, computed styles, accessibility queries and event delegation, and 1.3–3.6x over jsdom on React apps. It is not faster everywhere: happy-dom is slightly ahead on `mutation/synthetic-10k` and `startup/window-per-test-scripts`. rsdom also uses less memory: jsdom keeps about 1.7x as much heap alive and peaks at 1.75x the RSS. happy-dom is faster than jsdom in some scenarios but slower in most. Where it reads N/A, or is marked in the notes below, happy-dom lacks the API or returns different results, so its time isn't comparable.

<!-- BENCH:START -->
Measured 2026-10-10 on Apple M4 (darwin arm64), Node.js v24.21.0, rsdom at `c7588533`. Each number is the min of 10 timed iterations after 3 warmups, every scenario in a fresh process; a speedup is the other implementation's time / rsdom time (> 1 means rsdom is faster).

| Area | Scenario | jsdom 30.1.2 (ms) | happy-dom (ms) | rsdom (ms) | vs jsdom 30.1.2 | vs happy-dom |
|---|---|--:|--:|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 58.4 | 92.3 | 11.4 | 5.12x | 8.09x |
|  | `divs/innerHTML` | 171 | 151 | 36.2 | 4.74x | 4.17x |
|  | `lists/create-dom-api` | 49.0 | 73.6 | 13.0 | 3.78x | 5.68x |
|  | `lists/innerHTML` | 99.9 | 63.4 | 16.0 | 6.25x | 3.97x |
|  | `lists/query-iterate-read` | 95.1 | 121 | 40.2 | 2.37x | 3.01x |
| **Large documents** | `large/innerHTML-parse` | 333 | 251 | 48.4 | 6.88x | 5.19x |
|  | `large/jsdom-full-parse` | 253 | 269 | 48.8 | 5.18x | 5.51x |
|  | `large/serialize-outerHTML` | 71.8 | 140 | 19.6 | 3.67x | 7.14x |
|  | `large/serialize-dom` | 61.0 | 144 | 20.2 | 3.02x | 7.16x |
|  | `large/cloneNode-deep` | 220 | 226 | 21.5 | 10.2x | 10.5x |
| **Tables** | `tables/parse-innerHTML` | 365 | 311 | 59.8 | 6.10x | 5.19x |
|  | `tables/rows-cells-access` | 83.3 | 152 | 32.3 | 2.58x | 4.69x |
|  | `tables/nth-child-query` | 143 | 160 | 16.5 | 8.67x | 9.74x |
|  | `tables/sort-rows` | 116 | N/A | 22.7 | 5.10x | N/A |
|  | `tables/serialize` | 77.4 | 242 | 21.8 | 3.55x | 11.1x |
| **Selectors** | `selectors/complex-qsa` | 117 | 68.6 | 14.5 | 8.05x | 4.72x |
|  | `selectors/querySelector-many` | 1442 | 340 | 120 | 12.0x | 2.83x |
|  | `selectors/live-collections` | 112 | 336 | 12.4 | 9.07x | 27.1x |
|  | `selectors/matches-closest` | 111 | 26.8 | 5.73 | 19.4x | 4.67x |
| **Events and style** | `events/bubble-deep` | 129 | 144 | 61.9 | 2.08x | 2.33x |
|  | `events/many-targets-delegation` | 1595 | 22.8 | 20.9 | 76.3x | 1.09x |
|  | `style/inline-set` | 151 | 445 | 68.0 | 2.22x | 6.54x |
|  | `style/computed-style` | 2074 | 170 | 37.7 | 54.9x | 4.50x |
|  | `style/css-in-js-inject` | 266 | 153 | 55.0 | 4.84x | 2.78x |
|  | `style/css-in-js-insertRule` | 662 | 379 | 106 | 6.23x | 3.56x |
|  | `style/computed-after-mutation` | 782 | 242 | 91.0 | 8.60x | 2.66x |
| **React** | `react/render-dashboard` | 41.2 | 59.6 | 23.7 | 1.74x | 2.51x |
|  | `react/updates` | 149 | 185 | 111 | 1.34x | 1.66x |
|  | `react/unmount` | 36.9 | 69.8 | 10.6 | 3.50x | 6.62x |
|  | `react/complex-app` | 747 | 1059 | 468 | 1.60x | 2.26x |
|  | `react/testing-library-form` | 248 | 106 | 68.9 | 3.60x | 1.54x |
| **Accessibility queries and user-event** | `a11y/getByRole-page` | 1414 | 628 | 126 | 11.2x | 4.99x |
|  | `a11y/user-event-flow` | 291 | 153 | 136 | 2.15x | 1.13x |
| **Web components** | `webcomponents/shadow-render` | 132 | 59.8 | 44.5 | 2.96x | 1.34x |
| **Mutation observers** | `mutation/observed-updates` | 178 | 206 | 126 | 1.41x | 1.63x |
|  | `mutation/synthetic-10k` | 88.5 | 40.7 | 44.9 | 1.97x | 0.91x |
| **Template rendering** | `template/clone-render` | 83.0 | 99.3 | 17.7 | 4.68x | 5.60x |
|  | `template/lit-render` | 97.4 | 125 | 19.2 | 5.06x | 6.49x |
| **Forms** | `forms/big-form` | 220 | 395 | 51.3 | 4.30x | 7.70x |
| **Window startup** | `startup/window-per-test` | 330 | 286 | 270 | 1.22x | 1.06x |
|  | `startup/window-per-test-scripts` | 379 | 292 | 304 | 1.25x | 0.96x |
| **Real page parsing** | `parse/real-page` | 40.8 | 23.0 | 8.71 | 4.69x | 2.64x |
|  | `parse/real-page-serialize` | 51.5 | 67.7 | 32.6 | 1.58x | 2.08x |
|  | `parse/real-page-selectors` | 62.7 | 27.7 | 8.71 | 7.19x | 3.18x |
| **XML and SVG** | `xml/domparser-svg` | 77.5 | N/A | 45.3 | 1.71x | N/A |
|  | `xml/serializer-roundtrip` | 168 | N/A | 121 | 1.39x | N/A |
|  | `xml/getElementsByTagNameNS` | 118 | N/A | 61.0 | 1.93x | N/A |
|  | **Geometric mean** |  |  |  | **4.27x** | **3.66x** |

### Memory

**Retained heap** is the JS heap plus external memory still reachable after the scenario ran (the document is still held, as a test would hold it), over a baseline taken after the implementation was loaded; it is read after a full GC, as the median over the timed iterations. **Peak RSS** is the worker process's maximum resident set size over the whole run, including module loading and warmups, so it also reflects garbage the GC had not yet reclaimed. Lower is better; ratios are the other implementation's number / rsdom's.

| Area | Scenario | jsdom 30.1.2 retained (MB) | happy-dom retained (MB) | rsdom retained (MB) | jsdom 30.1.2 peak RSS (MB) | happy-dom peak RSS (MB) | rsdom peak RSS (MB) |
|---|---|--:|--:|--:|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 53.6 | 174 | 17.2 | 590 | 440 | 197 |
|  | `divs/innerHTML` | 63.5 | 227 | 23.9 | 710 | 507 | 270 |
|  | `lists/create-dom-api` | 38.2 | 123 | 37.1 | 451 | 366 | 264 |
|  | `lists/innerHTML` | 30.9 | 111 | 12.2 | 456 | 360 | 178 |
|  | `lists/query-iterate-read` | 178 | 133 | 25.1 | 544 | 489 | 362 |
| **Large documents** | `large/innerHTML-parse` | 103 | 373 | 34.7 | 985 | 691 | 321 |
|  | `large/jsdom-full-parse` | 103 | 373 | 34.6 | 959 | 691 | 369 |
|  | `large/serialize-outerHTML` | 103 | 374 | 33.1 | 972 | 1050 | 379 |
|  | `large/serialize-dom` | 103 | 374 | 33.1 | 970 | 1050 | 379 |
|  | `large/cloneNode-deep` | 201 | 749 | 59.5 | 1668 | 1525 | 394 |
| **Tables** | `tables/parse-innerHTML` | 133 | 470 | 41.5 | 1244 | 820 | 363 |
|  | `tables/rows-cells-access` | 145 | 493 | 96.9 | 1261 | 1319 | 570 |
|  | `tables/nth-child-query` | 357 | 523 | 45.7 | 1482 | 1353 | 606 |
|  | `tables/sort-rows` | 146 | N/A | 144 | 1280 | N/A | 599 |
|  | `tables/serialize` | 141 | 481 | 47.1 | 1253 | 1303 | 422 |
| **Selectors** | `selectors/complex-qsa` | 51.3 | 67.3 | 8.76 | 393 | 341 | 196 |
|  | `selectors/querySelector-many` | 26.1 | 74.2 | 9.28 | 343 | 353 | 176 |
|  | `selectors/live-collections` | 24.2 | 76.1 | 15.1 | 315 | 354 | 181 |
|  | `selectors/matches-closest` | 25.3 | 67.0 | 9.08 | 390 | 362 | 178 |
| **Events and style** | `events/bubble-deep` | 3.73 | 1.66 | 3.69 | 190 | 118 | 174 |
|  | `events/many-targets-delegation` | 22.9 | 9.28 | 23.3 | 275 | 187 | 209 |
|  | `style/inline-set` | 20.5 | 32.2 | 27.6 | 371 | 302 | 305 |
|  | `style/computed-style` | 46.4 | 40.7 | 47.8 | 334 | 298 | 293 |
|  | `style/css-in-js-inject` | 38.3 | 33.8 | 43.1 | 335 | 262 | 297 |
|  | `style/css-in-js-insertRule` | 29.1 | 56.8 | 34.0 | 334 | 294 | 310 |
|  | `style/computed-after-mutation` | 20.1 | 24.6 | 34.7 | 309 | 271 | 285 |
| **React** | `react/render-dashboard` | 18.9 | 43.7 | 20.5 | 259 | 278 | 200 |
|  | `react/updates` | 21.0 | 44.8 | 22.6 | 331 | 434 | 275 |
|  | `react/unmount` | 5.41 | 3.86 | 13.8 | 505 | 1013 | 395 |
|  | `react/complex-app` | 2.19 | 2.27 | 10.5 | 554 | 908 | 402 |
|  | `react/testing-library-form` | 14.6 | 8.54 | 24.8 | 290 | 249 | 270 |
| **Accessibility queries and user-event** | `a11y/getByRole-page` | 70.4 | 132 | 50.9 | 478 | 451 | 345 |
|  | `a11y/user-event-flow` | 18.1 | 7.94 | 23.6 | 302 | 272 | 254 |
| **Web components** | `webcomponents/shadow-render` | 62.6 | 64.5 | 24.5 | 449 | 311 | 305 |
| **Mutation observers** | `mutation/observed-updates` | 35.3 | 46.4 | 22.7 | 379 | 439 | 277 |
|  | `mutation/synthetic-10k` | 4.28 | 2.65 | 4.90 | 266 | 247 | 241 |
| **Template rendering** | `template/clone-render` | 132 | 98.7 | 11.3 | 476 | 355 | 190 |
|  | `template/lit-render` | 2.57 | 4.79 | 1.94 | 275 | 913 | 226 |
| **Forms** | `forms/big-form` | 10.7 | 50.8 | 6.65 | 291 | 321 | 179 |
| **Window startup** | `startup/window-per-test` | 10.2 | 0.76 | 3.65 | 1779 | 256 | 464 |
|  | `startup/window-per-test-scripts` | 10.8 | 0.94 | 7.24 | 2040 | 281 | 740 |
| **Real page parsing** | `parse/real-page` | 15.8 | 31.8 | 14.8 | 265 | 249 | 173 |
|  | `parse/real-page-serialize` | 14.2 | 31.8 | 15.1 | 327 | 312 | 211 |
|  | `parse/real-page-selectors` | 60.8 | 36.1 | 15.2 | 355 | 301 | 197 |
| **XML and SVG** | `xml/domparser-svg` | 2.56 | N/A | 0.00 | 278 | N/A | 174 |
|  | `xml/serializer-roundtrip` | 28.1 | N/A | 15.6 | 311 | N/A | 263 |
|  | `xml/getElementsByTagNameNS` | 22.3 | N/A | 4.48 | 296 | N/A | 269 |

jsdom 30.1.2 retains **1.72x** as much heap as rsdom (geometric mean over the 46 scenarios where both keep at least 1 MB) and peaks at **1.75x** its RSS; happy-dom retains **2.82x** as much heap as rsdom (geometric mean over the 41 scenarios where both keep at least 1 MB) and peaks at **1.54x** its RSS.

Regenerate this table with `node bench/report.js` after a full `node bench/run.js`.
<!-- BENCH:END -->

Notes on happy-dom 20.14.6: `tables/sort-rows` needs `HTMLTableSectionElement.rows`, which it doesn't implement. In `selectors/complex-qsa` it returns wrong results (`:enabled` matches nothing, and a sibling-combinator query returns duplicates). In `style/computed-style` it does less work (values such as colours and `calc()` are not resolved).

## Credits and licence

rsdom is a fork of [jsdom](https://github.com/jsdom/jsdom) and is MIT-licensed; see [LICENSE](LICENSE), which keeps jsdom's original copyright notice as its licence requires. The vendored html5ever sources under `src/native/vendor/` keep their original MIT/Apache-2.0 licences.
