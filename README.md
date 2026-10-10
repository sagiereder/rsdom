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

The benchmarks in `bench/` compare rsdom with the published jsdom 30.1.2 and [happy-dom](https://github.com/capricorn86/happy-dom). Each implementation and scenario runs in a fresh process. The scenarios cover simple divs and lists, large documents, huge tables, selectors, events, styles, and React apps (a dashboard and a complex multi-page app with forms, tables and modals, in development and production builds, plus Testing Library).

```sh
cd bench && npm install
node run.js                         # upstream jsdom vs rsdom, writes results/<timestamp>.json
node run.js --impls upstream,fork-js,fork,happy-dom --stat min   # the run behind the table below
node run.js --mode happy            # happy-dom vs rsdom
node run.js --quick --filter selectors
node run.js --mode native           # rsdom with JSDOM_NATIVE=0 vs rsdom
node report.js                      # rewrite the table below from the newest results file
```

## Benchmark results

Across all scenarios rsdom is **4.9x faster than jsdom** and **4.7x faster than happy-dom** (geometric mean), with the biggest gains on selectors, computed styles and event delegation, and 1.3–3.7x over jsdom on React apps. happy-dom is faster than jsdom in some scenarios but slower in most. Where it reads N/A, or is marked in the notes below, happy-dom lacks the API or returns different results, so its time isn't comparable.

<!-- BENCH:START -->
Measured 2026-10-09 on Apple M4 (darwin arm64), Node.js v24.21.0, rsdom at `a9c33c68`. Each number is the min of 10 timed iterations after 3 warmups, every scenario in a fresh process; a speedup is the other implementation's time / rsdom time (> 1 means rsdom is faster).

| Area | Scenario | jsdom 30.1.2 (ms) | happy-dom (ms) | rsdom (ms) | vs jsdom 30.1.2 | vs happy-dom |
|---|---|--:|--:|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 57.4 | 86.0 | 11.1 | 5.17x | 7.75x |
|  | `divs/innerHTML` | 160 | 137 | 30.4 | 5.27x | 4.50x |
|  | `lists/create-dom-api` | 45.2 | 65.0 | 11.8 | 3.84x | 5.52x |
|  | `lists/innerHTML` | 86.0 | 55.1 | 11.4 | 7.53x | 4.82x |
|  | `lists/query-iterate-read` | 90.7 | 112 | 35.6 | 2.55x | 3.15x |
| **Large documents** | `large/innerHTML-parse` | 293 | 219 | 43.4 | 6.76x | 5.05x |
|  | `large/jsdom-full-parse` | 219 | 231 | 45.7 | 4.80x | 5.05x |
|  | `large/serialize-outerHTML` | 66.7 | 135 | 18.8 | 3.55x | 7.20x |
|  | `large/serialize-dom` | 59.6 | 137 | 16.4 | 3.64x | 8.36x |
|  | `large/cloneNode-deep` | 196 | 199 | 27.7 | 7.07x | 7.17x |
| **Tables** | `tables/parse-innerHTML` | 322 | 264 | 53.3 | 6.04x | 4.94x |
|  | `tables/rows-cells-access` | 76.1 | 147 | 29.2 | 2.61x | 5.03x |
|  | `tables/nth-child-query` | 129 | 146 | 17.2 | 7.52x | 8.50x |
|  | `tables/sort-rows` | 106 | N/A | 27.7 | 3.83x | N/A |
|  | `tables/serialize` | 78.8 | 173 | 17.4 | 4.53x | 9.97x |
| **Selectors** | `selectors/complex-qsa` | 66.1 | 37.2 | 7.78 | 8.49x | 4.78x |
|  | `selectors/querySelector-many` | 832 | 187 | 66.1 | 12.6x | 2.83x |
|  | `selectors/live-collections` | 61.0 | 205 | 5.65 | 10.8x | 36.2x |
|  | `selectors/matches-closest` | 58.2 | 14.1 | 3.13 | 18.6x | 4.49x |
| **Events and style** | `events/bubble-deep` | 69.1 | 76.1 | 32.0 | 2.16x | 2.38x |
|  | `events/many-targets-delegation` | 908 | 11.4 | 9.82 | 92.4x | 1.16x |
|  | `style/inline-set` | 84.5 | 254 | 32.5 | 2.60x | 7.82x |
|  | `style/computed-style` | 1200 | 167 | 44.3 | 27.1x | 3.77x |
| **React** | `react/render-dashboard` | 39.3 | 58.6 | 19.6 | 2.01x | 3.00x |
|  | `react/updates` | 145 | 178 | 108 | 1.34x | 1.65x |
|  | `react/unmount` | 35.6 | 72.8 | 12.1 | 2.95x | 6.02x |
|  | `react/complex-app` | 731 | 1043 | 457 | 1.60x | 2.28x |
|  | `react/testing-library-form` | 239 | 105 | 67.3 | 3.55x | 1.56x |
| **React (production build)** | `react-prod/render-dashboard` | 28.4 | 42.3 | 11.0 | 2.57x | 3.84x |
|  | `react-prod/updates` | 64.8 | 95.6 | 28.3 | 2.29x | 3.37x |
|  | `react-prod/unmount` | 33.5 | 68.8 | 8.99 | 3.73x | 7.65x |
|  | `react-prod/complex-app` | 417 | 695 | 164 | 2.55x | 4.24x |
|  | **Geometric mean** |  |  |  | **4.86x** | **4.66x** |

Regenerate this table with `node bench/report.js` after a full `node bench/run.js`.
<!-- BENCH:END -->

Notes on happy-dom 20.14.6: `tables/sort-rows` needs `HTMLTableSectionElement.rows`, which it doesn't implement. In `selectors/complex-qsa` it returns wrong results (`:enabled` matches nothing, and a sibling-combinator query returns duplicates). In `style/computed-style` it does less work (values such as colours and `calc()` are not resolved).

## Credits and licence

rsdom is a fork of [jsdom](https://github.com/jsdom/jsdom) and is MIT-licensed; see [LICENSE](LICENSE), which keeps jsdom's original copyright notice as its licence requires. The vendored html5ever sources under `src/native/vendor/` keep their original MIT/Apache-2.0 licences.
