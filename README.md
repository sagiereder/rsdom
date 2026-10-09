# rsdom

rsdom is a drop-in fork of [jsdom](https://github.com/jsdom/jsdom) with a Rust core for its hot paths. It keeps jsdom 30.1.2's public API, so `const { JSDOM } = require("rsdom")` works wherever `require("jsdom")` did. The same test suite passes: the jsdom API tests, the ported legacy tests, and every web-platform-test that jsdom 30.1.2 runs.

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
npm install rsdom
```

npm also installs the prebuilt addon for your platform: macOS (arm64 or x64), Linux (x64 or arm64 with glibc, or x64 with musl) or Windows (x64). It comes from a package such as `rsdom-darwin-arm64`, which rsdom lists as an optional dependency. On other platforms, or with `--omit=optional`, rsdom runs on its pure-JS paths and behaves the same, just slower.

## Use with Jest / Vitest

rsdom ships test environments that mirror `jest-environment-jsdom` and Vitest's built-in `jsdom` environment. Switching only takes a config change. Testing Library, user-event and fake timers work as they do with jsdom.

### Jest

```sh
npm install --save-dev rsdom
```

```js
// jest.config.js
module.exports = {
  testEnvironment: "rsdom/jest",
  // Optional, same as with jest-environment-jsdom: html, url, userAgent, customExportConditions,
  // or any JSDOM constructor option.
  testEnvironmentOptions: { url: "http://localhost/" }
};
```

`rsdom/jest` uses the `jest-util`, `jest-mock` and `@jest/fake-timers` that come with Jest. If your package manager doesn't hoist them (pnpm, Yarn PnP), install `jest-environment-rsdom` instead, which depends on them directly, and use `testEnvironment: "rsdom"`. A per-file `/** @jest-environment rsdom/jest */` docblock works too.

### Vitest

```sh
npm install --save-dev rsdom vitest-environment-rsdom
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

Vitest resolves `environment: "rsdom"` to the `vitest-environment-rsdom` package. Without that package, point at the file directly: `environment: "./node_modules/rsdom/src/integrations/vitest.js"`. A per-file `// @vitest-environment rsdom` comment works too. All pools are supported, including `vmThreads` and `vmForks`.

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

The benchmarks in `bench/` compare rsdom with the published jsdom 30.1.2. Each implementation and scenario runs in a fresh process.

```sh
cd bench && npm install
node run.js                         # upstream jsdom vs rsdom, writes results/<timestamp>.json
node run.js --quick --filter selectors
node run.js --mode native           # rsdom with JSDOM_NATIVE=0 vs rsdom
node report.js                      # rewrite the table below from the newest results file
```

## Benchmark results

<!-- BENCH:START -->
Measured 2026-10-09 on Apple M4 (darwin arm64), Node.js v24.21.0, rsdom at `7c7360c8`. Each number is the median of 10 timed iterations after 3 warmups, every scenario in a fresh process; speedup = jsdom 30.1.2 time / rsdom time.

| Area | Scenario | jsdom 30.1.2 (ms) | rsdom (ms) | Speedup |
|---|---|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 85.1 | 49.4 | 1.72x |
|  | `divs/innerHTML` | 306 | 111 | 2.75x |
|  | `lists/create-dom-api` | 81.7 | 45.2 | 1.81x |
|  | `lists/innerHTML` | 162 | 41.8 | 3.87x |
|  | `lists/query-iterate-read` | 156 | 112 | 1.40x |
| **Large documents** | `large/innerHTML-parse` | 510 | 150 | 3.40x |
|  | `large/jsdom-full-parse` | 392 | 146 | 2.68x |
|  | `large/serialize-outerHTML` | 114 | 42.2 | 2.71x |
|  | `large/serialize-dom` | 105 | 38.6 | 2.73x |
|  | `large/cloneNode-deep` | 391 | 157 | 2.49x |
| **Tables** | `tables/parse-innerHTML` | 595 | 268 | 2.22x |
|  | `tables/rows-cells-access` | 147 | 99.5 | 1.48x |
|  | `tables/nth-child-query` | 225 | 32.8 | 6.87x |
|  | `tables/sort-rows` | 189 | 109 | 1.74x |
|  | `tables/serialize` | 140 | 49.1 | 2.85x |
| **Selectors** | `selectors/complex-qsa` | 114 | 18.3 | 6.24x |
|  | `selectors/querySelector-many` | 1308 | 112 | 11.7x |
|  | `selectors/live-collections` | 150 | 19.8 | 7.59x |
|  | `selectors/matches-closest` | 113 | 6.57 | 17.2x |
| **Events and style** | `events/bubble-deep` | 458 | 372 | 1.23x |
|  | `events/many-targets-delegation` | 4841 | 300 | 16.1x |
|  | `style/inline-set` | 333 | 118 | 2.81x |
|  | `style/computed-style` | 2533 | 72.5 | 35.0x |
| **React** | `react/render-dashboard` | 62.1 | 41.3 | 1.50x |
|  | `react/updates` | 212 | 175 | 1.21x |
|  | `react/unmount` | 47.5 | 21.8 | 2.18x |
|  | `react/testing-library-form` | 368 | 112 | 3.29x |
| | **Geometric mean** | | | **3.39x** |

Regenerate this table with `node bench/report.js` after a full `node bench/run.js`.
<!-- BENCH:END -->

## Credits and licence

rsdom is built on [jsdom](https://github.com/jsdom/jsdom) by Elijah Insua, Domenic Denicola and the jsdom contributors. jsdom's MIT licence is kept in [LICENSE.txt](LICENSE.txt). rsdom's own changes are MIT-licensed as well (see [LICENSE](LICENSE)). The vendored html5ever sources under `src/native/vendor/` keep their original MIT/Apache-2.0 licences.
