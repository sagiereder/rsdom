# rsdom

rsdom is a drop-in fork of [jsdom](https://github.com/jsdom/jsdom) with a Rust core for its hot paths. It keeps jsdom 30.1.2's public API, so `const { JSDOM } = require("@rsdom/core")` works wherever `require("jsdom")` did. The same test suite passes: the jsdom API tests, the ported legacy tests, and every web-platform-test that jsdom 30.1.2 runs.

For the API itself (`new JSDOM()`, options, `runScripts`, resource loading, virtual consoles and so on), see the upstream documentation in [docs/jsdom-api.md](docs/jsdom-api.md). Everything there applies to rsdom.

## Why

jsdom is the DOM behind most JavaScript test runners (Jest, Vitest and Testing Library) and a lot of server-side rendering and scraping code. In those workloads, the time goes into parsing HTML, running selectors, dispatching events and computing styles, again and again. rsdom makes those paths faster without changing behaviour, so test suites and SSR pipelines speed up with no code changes.

## How it works

- **Native HTML parsing.** HTML is parsed by [html5ever](https://github.com/servo/html5ever), which is vendored and patched for exact parse5 parity, inside a napi-rs addon (`src/native/`). The addon emits a compact instruction stream. JavaScript (`src/jsdom/browser/parser/html-native.js`) replays that stream to build ordinary jsdom nodes, so the resulting tree is the same object model jsdom always had.
- **Native or WebAssembly, no JS parser fallback.** The Rust core loads as a native Node-API addon where a prebuilt binary exists, and otherwise as a WebAssembly build of the same crate (`@rsdom/core-wasm32-wasi`), which runs anywhere. If neither loads, `require("@rsdom/core")` throws an error that lists what it tried. parse5 is only a development dependency: the differential tests (`tests/differential/`) check that rsdom's parser builds the same trees, with the same source locations, as parse5, and that its encoding sniffing matches html-encoding-sniffer, which is also a development dependency only. `JSDOM_NATIVE=native` or `JSDOM_NATIVE=wasm` forces one build. The test suite passes with both.
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
node src/native/build.js --target wasm32-wasip1   # optional: the WebAssembly build, to src/native/jsdom-native.wasm
```

rsdom loads the native addon if it is built, and otherwise the WebAssembly build (`rustup target add wasm32-wasip1` first). With neither, it throws.

## Running tests

The web-platform-tests live in a git submodule (`tests/web-platform-tests/tests`). Run `npm run wpt:init` once, and set up your hosts file as the [WPT docs](https://web-platform-tests.org/running-tests/from-local-system.html#system-setup) describe.

```sh
node scripts/dev/test.js            # tests relevant to files changed vs. the rust branch
node scripts/dev/test.js --all      # the whole suite, sharded across CPUs
node scripts/dev/test.js --wpt dom/nodes,html/syntax
node scripts/dev/test.js --api
JSDOM_NATIVE=wasm node scripts/dev/test.js --all   # with the WebAssembly build
npm run test:differential           # the HTML parser against parse5 and encoding sniffing against html-encoding-sniffer (RSDOM_FUZZ_COUNT=N for more fuzzing)
```

The upstream npm scripts (`npm run test:api`, `test:wpt`, `test:tuwpt`, `test:to-port-to-wpts`) still work. See [tests/README.md](tests/README.md).

## Benchmarks

rsdom is **4.3x faster than jsdom** and **3.7x faster than happy-dom** across the benchmark suite (geometric mean), and uses less memory. The suite covers simple divs and lists, large documents, huge tables, selectors, events, styles, and React apps with Testing Library, using React's development builds as Jest and Vitest do. Gains are largest on selectors, computed styles and event handling. They are smallest on window startup and mutation observers, where happy-dom is about as fast.

<!-- BENCH:START -->
Speedup of rsdom (other implementation's time / rsdom time, geometric mean over each area's scenarios; > 1 means rsdom is faster). Measured 2026-10-13 on Apple M4, Node.js v24.21.0.

| Area | Scenarios | vs jsdom 30.1.2 | vs happy-dom |
|---|--:|--:|--:|
| Simple divs and lists | 5 | 4.31x | 4.63x |
| Large documents | 5 | 5.39x | 7.07x |
| Tables | 5 | 4.44x | 6.57x |
| Selectors | 4 | 11.3x | 6.60x |
| Events and style | 7 | 8.31x | 3.01x |
| React | 5 | 1.99x | 2.41x |
| Accessibility queries and user-event | 2 | 4.58x | 2.19x |
| Web components | 1 | 3.07x | 1.48x |
| Mutation observers | 2 | 1.60x | 1.30x |
| Template rendering | 2 | 4.48x | 5.55x |
| Forms | 1 | 3.98x | 7.24x |
| Window startup | 2 | 1.34x | 1.40x |
| Real page parsing | 3 | 4.01x | 2.79x |
| XML and SVG | 3 | 2.78x | N/A |
| **All** | **47** | **4.29x** | **3.70x** |

jsdom 30.1.2 retains **1.78x** as much heap as rsdom (geometric mean over the 46 scenarios where both keep at least 1 MB) and peaks at **1.81x** its RSS; happy-dom retains **2.92x** as much heap as rsdom (geometric mean over the 41 scenarios where both keep at least 1 MB) and peaks at **1.56x** its RSS.
<!-- BENCH:END -->

Every scenario, the memory tables and how to run the suite: [BENCHMARKS.md](BENCHMARKS.md).

## Credits and licence

rsdom is a fork of [jsdom](https://github.com/jsdom/jsdom) and is MIT-licensed; see [LICENSE](LICENSE), which keeps jsdom's original copyright notice as its licence requires. The vendored html5ever sources under `src/native/vendor/` keep their original MIT/Apache-2.0 licences.
