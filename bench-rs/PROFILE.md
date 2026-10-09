# jsdom-rs: benchmark baseline and profile analysis

This file sets the performance targets for moving jsdom hot paths to Rust. It covers:

- the scenarios in `bench-rs/scenarios/`
- the baseline timings, with upstream jsdom@30.1.2, the fork with JS only, and the fork with native enabled
- the CPU hotspots for each scenario group
- a ranked list of what should move to Rust and what should be fixed in JS

## How to run

```sh
source .devshim/env.sh
cd bench-rs && npm install          # once
node run.js                         # upstream vs fork-js vs fork (native on) vs happy-dom
node run.js --mode upstream         # upstream vs fork
node run.js --mode native           # fork-js (JSDOM_NATIVE=0) vs fork
node run.js --mode happy            # happy-dom vs fork
node run.js --filter react --quick  # subset, 1 warmup + 3 iterations
node run.js --stat min              # rank by fastest iteration (use on a loaded machine)
node profile.js react/testing-library-form --impl fork-js --top 40
```

- Each (impl, scenario) pair runs in its own `node --expose-gc` child process.
- Each iteration gets an untimed `setup()`, usually a fresh DOM, followed by a forced GC. Only `run()` is timed.
- Scenarios create DOMs through `ctx.createDom(html, opts)` (`lib/impls.js`), which wraps `new JSDOM(html, opts)` or
  happy-dom's `new Window({ url, settings })` + `document.write(html)` behind one `{ window, serialize(), close() }`
  handle. happy-dom windows are closed with `window.happyDOM.close()`.
- A scenario an impl cannot run declares `unsupported: { impl: reason }` and is reported as N/A. A scenario where an
  impl runs but gives different results declares `caveats` and is marked `*` in the table.
- Results go to `results/<timestamp>.json`. Only `results/baseline.json` is committed.
- `profile.js` uses the in-process inspector Profiler. It samples every 100µs and only during the measured `run()` calls.
- `profile.js` prints four reports:
  - self time by category (jsdom lib directory or npm package)
  - the top functions by self time
  - jsdom `lib/` functions by inclusive time, counting recursion once
  - jsdom `lib/` files by self time

## Scenarios

| group | scenario | what it does |
|---|---|---|
| divs | `divs/create-dom-api` | 20k divs: createElement + className + textContent + appendChild |
| divs | `divs/innerHTML` | 20k divs set through one innerHTML string |
| lists | `lists/create-dom-api` | 10k `<li>`: setAttribute, classList.add, append(text) |
| lists | `lists/innerHTML` | 10k `<li>` through innerHTML |
| lists | `lists/query-iterate-read` | qSA('li'), children[i], sibling walk, textContent, dataset, ×5 |
| large | `large/innerHTML-parse` | ~50k-node nested and wide tree (6-ary, depth 5, inline leaves) |
| large | `large/jsdom-full-parse` | `new JSDOM(html)` of the same tree |
| large | `large/serialize-outerHTML` | body.outerHTML + innerHTML, ×2 |
| large | `large/serialize-dom` | `dom.serialize()` ×4 |
| large | `large/cloneNode-deep` | `cloneNode(true)` of the tree, then append |
| tables | `tables/parse-innerHTML` | 5000×10 table through innerHTML |
| tables | `tables/rows-cells-access` | `table.rows[r].cells[c].textContent`, ×3 |
| tables | `tables/nth-child-query` | `td:nth-child(3)`, `tr.alt > td.c5`, `tbody tr:nth-child(odd) td:last-child` |
| tables | `tables/sort-rows` | sort by a numeric column by re-appending `<tr>`, ascending then descending |
| tables | `tables/serialize` | table.outerHTML ×4 |
| selectors | `selectors/complex-qsa` | 14 complex selectors (`:has`, `:is`, `:where`, `:not`, nth-*, attribute operators, combinators) ×2 on ~8k elements |
| selectors | `selectors/querySelector-many` | 2000 querySelector calls (attribute, id-scoped, element-scoped) |
| selectors | `selectors/live-collections` | getElementsByClassName/TagName iteration interleaved with mutations |
| selectors | `selectors/matches-closest` | matches() + 2×closest() on every li/a/button/badge, ×2 |
| events | `events/bubble-deep` | 4000 MouseEvents + 1000 input events through a 40-deep path, with capture and bubble listeners at every level |
| events | `events/many-targets-delegation` | React-style root delegation: click() + focus() on 750 controls |
| style | `style/inline-set` | 3000 elements × 10 `style.x =` / setProperty writes + cssText read |
| style | `style/computed-style` | getComputedStyle on 1500 elements, 200-rule stylesheet, 6 properties read |
| react | `react/render-dashboard` | createRoot + act(render): header/nav, sidebar, 12 stat cards, 250-row table, 16-field form, feed (~4.2k elements) |
| react | `react/updates` | 48 act() updates: sort, filter, theme toggle (inline styles), row select, feed show/hide |
| react | `react/unmount` | act(unmount) of 8 dashboards (~33k elements) |
| react | `react/testing-library-form` | RTL render + getByRole/getByLabelText/getByText/getAllByRole + fireEvent typing (one change per keystroke) and clicks |

React runs in its development build (NODE_ENV unset), the same as in jest or vitest.

## Baseline

Run conditions: Apple M4, Node 24.21.0, git `b69f01f`. The fork is identical to upstream apart from the addon skeleton, so every ratio should be about 1.0. Ratios between 0.9 and 1.1 are noise.

This is `results/baseline.json`, the first full `--mode all` run with 3 warmup and 10 measured iterations.

**Caveat:** other agents were running mocha suites on the same machine. Load was high during the run and peaked at about 190 shortly afterwards. The last rows of the table are contaminated:

- **react/unmount (fork)** measured 439ms. I re-ran fork-js in isolation under a load average of 190 and got steady times of 205–267ms, so this is machine load, not a leak.
- **react/testing-library-form (upstream)** measured 1097ms.
- **events/many-targets-delegation (fork)** measured 1135ms.

A re-check of those three rows at a load average of about 18 (`--filter react/unmount,testing-library,many-targets --mode all`) gave these medians, upstream / fork-js / fork:

| scenario | upstream | fork-js | fork |
|---|--:|--:|--:|
| events/many-targets-delegation | 933 | 904 | 921 |
| react/unmount | 38.1 | 38.6 | 51.0 (cv > 15%) |
| react/testing-library-form | 251 | 383 | 357 |

RTL is the most load-sensitive scenario. Back-to-back `--stat min` runs gave 502ms for upstream and 347ms for fork-js. Use `--stat min` or several runs before trusting any RTL ratio.

The baseline JSON was written before `run.js` recorded `cv`. Newer result files include it, and the console table marks noisy cells with `~`.

| scenario | upstream median ms | fork-js median | fork median | fork/up (median) | upstream min | fork min | fork/up (min) |
|---|--:|--:|--:|--:|--:|--:|--:|
| divs/create-dom-api | 64.7 | 63.4 | 63.3 | 1.02x | 58.1 | 57.7 | 1.01x |
| divs/innerHTML | 175 | 175 | 179 | 0.98x | 160 | 159 | 1.00x |
| lists/create-dom-api | 48.2 | 47.7 | 47.9 | 1.01x | 45.5 | 45.0 | 1.01x |
| lists/innerHTML | 96.8 | 95.2 | 95.1 | 1.02x | 87.6 | 87.2 | 1.00x |
| lists/query-iterate-read | 94.9 | 94.6 | 96.0 | 0.99x | 90.7 | 90.9 | 1.00x |
| large/innerHTML-parse | 336 | 327 | 325 | 1.03x | 303 | 295 | 1.03x |
| large/jsdom-full-parse | 244 | 242 | 251 | 0.97x | 227 | 234 | 0.97x |
| large/serialize-outerHTML | 78.1 | 78.5 | 77.4 | 1.01x | 74.7 | 70.5 | 1.06x |
| large/serialize-dom | 68.7 | 69.7 | 69.9 | 0.98x | 62.3 | 59.4 | 1.05x |
| large/cloneNode-deep | 247 | 238 | 234 | 1.05x | 212 | 213 | 0.99x |
| tables/parse-innerHTML | 388 | 393 | 389 | 1.00x | 348 | 346 | 1.01x |
| tables/rows-cells-access | 102 | 106 | 106 | 0.97x | 81.5 | 90.4 | 0.90x |
| tables/nth-child-query | 176 | 186 | 183 | 0.96x | 163 | 165 | 0.99x |
| tables/sort-rows | 154 | 154 | 169 | 0.91x | 131 | 131 | 1.00x |
| tables/serialize | 120 | 121 | 129 | 0.93x | 101 | 105 | 0.96x |
| selectors/complex-qsa | 90.3 | 93.4 | 92.9 | 0.97x | 88.2 | 88.7 | 0.99x |
| selectors/querySelector-many | 970 | 958 | 924 | 1.05x | 913 | 913 | 1.00x |
| selectors/live-collections | 77.6 | 82.7 | 76.6 | 1.01x | 69.5 | 72.8 | 0.96x |
| selectors/matches-closest | 75.6 | 74.8 | 74.8 | 1.01x | 68.3 | 71.2 | 0.96x |
| events/bubble-deep | 81.4 | 82.5 | 84.4 | 0.96x | 79.3 | 83.7 | 0.95x |
| events/many-targets-delegation | 973 | 952 | 1135 | 0.86x | 953 | 920 | 1.04x |
| style/inline-set | 98.7 | 99.2 | 97.7 | 1.01x | 94.2 | 94.4 | 1.00x |
| style/computed-style | 1303 | 1357 | 1369 | 0.95x | 1293 | 1319 | 0.98x |
| react/render-dashboard | 49.5 | 50.3 | 52.8 | 0.94x | 44.5 | 51.1 | 0.87x |
| react/updates | 181 | 187 | 182 | 1.00x | 176 | 178 | 0.99x |
| react/unmount | 48.1 | 55.7 | 439 | 0.11x | 44.4 | 243 | 0.18x |
| react/testing-library-form | 1097 | 542 | 519 | 2.12x | 627 | 420 | 1.49x |

## Hotspots by group

The profiles below were taken with `--impl fork-js`, 4 iterations. Percentages are shares of the sampled time inside `run()`.

### Parsing: divs, lists, large, and tables innerHTML / `new JSDOM`

parse5's tokenizer and tree builder take only **12–20%** of self time. Most of the cost is jsdom's per-node tree insertion, which the parse5 adapter in `lib/jsdom/browser/parser/html.js` triggers for every node.

| % (large/innerHTML-parse) | function |
|--:|---|
| 44% incl | `_insert` `lib/jsdom/living/nodes/Node-impl.js:1012` (self 13.6%) |
| 9% | GC |
| 5.3% | `_remove` `Node-impl.js:1202` |
| 5.1% | `_invalidateCaches` `Node-impl.js:472` |
| 5.0% / 4.9% | `get parentNode` `Node-impl.js:291`, `getRootNode` `Node-impl.js:367` |
| 3.7% | `next` `lib/jsdom/living/helpers/dom-tree.js:116` |
| 20.6% incl | adapter `insertText` `html.js:139` (`lastChild.data += text` goes through `replaceData`) |
| 15.5% incl | adapter `createElement` `html.js:60`, then `create-element.js:176` and the generated `setup` |
| 13.3% incl | `_replaceAll` and `detachNode` → `remove()`: the fragment is built, then every node is moved |
| 6% incl | `CSSStyleProperties.createImpl` for each element during full-document parse |

Causes:

- Every append runs the full DOM insert algorithm:
  - live-range checks
  - `_adoptNode`
  - `_invalidateCaches`, which walks all ancestors
  - `getRootNode` and `isConnected`, which also walk to the root
  - `addSubtreeToDocumentCaches`
  - a mutation record
  - a `_shadowIncludingInclusiveDescendants` walk
- The per-node cost is about 3.5–6.5µs.

### Serialization: large/serialize-*, tables/serialize

| % | function |
|--:|---|
| 36% / 19% | parse5 `serializeElement` `parse5/dist/serializer/index.js:115` |
| 17–20% | `childrenToArray` `dom-tree.js:140`: the adapter allocates a child array for every node |
| 9–10% | adapter `getTagName` / `getAttrList` / `getNamespaceURI` `lib/jsdom/living/domparsing/parse5-adapter-serialization.js` |
| 5% | `entities` `escapeWithRegex` |
| 20% (tables) | GC from string concatenation |

There is also a one-off 9.5% for the `document` named-property cache build (`Document-impl.js:661`). It is a full `_descendantsToArray` walk on the first `document.*` property access after the tree changes.

### cloneNode

- 72% of the time is in `cloneNode`. Of that, 52% is `_append` → `_insert`, which runs the same insert overhead as parsing for every cloned child.
- `cloneSingleNode` takes 29%, mostly element construction through the generated wrappers.

### Selectors

- The work splits into `@asamuzakjp/dom-selector` (38–54%) and `lib/generated/idl` (25–30%).
- dom-selector works on **wrappers through the public API**, so every attribute or tag check crosses the wrapper boundary. The main costs are:
  - `implForWrapperWithInterface` `utils.js:125` (8–13%)
  - `isHTMLElement` `utility.js:245` (16% in querySelector-many)
  - `get nodeType`, `get localName`, `getAttribute`, `get ownerDocument`
  - the `Document` proxy `get` trap `Document.js:3031` (3.6–13% incl). It checks named properties on every `document.x` access.
- querySelector-many: 96% is in `querySelector`. dom-selector's TreeWalker (`nextNode` `TreeWalker-impl.js:98`) and `#traverseAndCollectNodes` scan the tree for every call. Each call costs about 0.45ms on an 8k-element tree.
- complex-qsa and nth-child: 17–44% is in `HTMLCollection` construction. dom-selector calls `getElementsByTagName`/`ClassName`, and each call runs `descendantsToArray` `dom-tree.js:150` over the whole document.
- live-collections: 83% is `HTMLCollection._update`, which rebuilds the full descendant array after any mutation (`html-collections.js:23/64`).
- matches-closest: 17% is spent resolving `<a href>` URLs (`HTMLHyperlinkElementUtils` → whatwg-url) from inside dom-selector's `resolveContent`.

### Events

- bubble-deep: 70% is in `lib/jsdom/living/events`. The main costs are:
  - `_dispatch` `EventTarget-impl.js:147` (25% self)
  - `invokeEventListeners` and `innerInvokeEventListeners` (25%)
  - Event construction (13%)
- This is about 20µs per event on a 40-level path. All of it is JS logic and callbacks.
- many-targets-delegation: **80% is in `focus()`**. `isFocusableAreaElement` (`focusing.js:17`) calls `getComputedStyleDeclaration`, which runs the full cascade against the **default UA stylesheet**. That takes about 7ms per focus. click() is only 16%.

### Style

- computed-style: 95% is in `prepareComputedStyleDeclaration` (`lib/jsdom/living/css/helpers/computed-style.js:44`).
- For every matching rule and declaration, the cascade calls `declaration.setProperty(property, value)` (61% incl). That re-parses the value string with css-tree:
  - `clone`
  - `TokenStream`
  - lru-cache (13%)
  - css-color (6%)
  - the border shorthand expansion `_borderSetter` / `prepareBorderProperties` `shorthand-properties.js:963` (50% incl)
- Selector matching through dom-selector `check()` takes 29%.
- The UA stylesheet and author sheets are scanned linearly for every element. `ruleMightMatchElement` is the only prefilter.
- inline-set: `_updateStyle` is 80% incl. `get cssText` (`CSSStyleDeclaration-impl.js:63`) is 20% self. lru-cache and border shorthand handling are also significant.

### React

- render-dashboard: `react` and `react-dom` together take 36%. jsdom insert takes 20% incl, createElement 12%, setAttribute 8%, and style setters 6%.
- updates: React itself takes 56%. jsdom DOM mutations are about 10–15%.
- unmount: 37% incl is in the `document` named-property getter (`Document-impl.js:661/708`). React's `removeChild` invalidates the cache, and the next `document.*` access rebuilds it with a full-tree `_descendantsToArray`, so the cost grows as O(n) per removal batch. `_remove` takes 12%. React's own `detachDeletedInstance` takes 14%.
- testing-library-form: **47% incl is getComputedStyle**, from RTL's `isInaccessible` and visibility checks in `getByRole`:
  - `matches` takes 40%, through dom-selector.
  - `getInheritedPropertyValue` takes 22%: inherited lookups compute the cascade for each ancestor.
  - dom-selector takes 23% self. RTL's own role queries call `matches()` many times.
  - React takes 22%.

## napi overhead

I measured this with the existing `nativeVersion()` export, so `native/` was not changed. The test was 5M calls on an M4 with Node 24:

- **about 29ns per call**, including creating the returned JS string
- 1.6ns for an equivalent JS function

Published napi-rs figures for other operations:

| operation | approximate cost |
|---|---|
| UTF-8 string argument | ~0.5–1ns per byte, plus ~20ns |
| object creation plus one property set | ~50–100ns |
| JS callback from Rust | ~100–200ns |

Conclusions:

- **Coarse operations are cheap.** One call that parses 1MB of HTML, or matches a selector over a whole tree held in Rust, pays a negligible fixed cost.
- **Per-node calls are expensive.** Some designs call into Rust once per node, or call back into JS for every node a matcher visits, such as reading attributes from JS impls. Those calls cost 30–200ns each, which is close to the per-node JS cost they would replace. Use JS for those paths.

## Recommendations, ranked by expected win

1. **Batched parse in Rust (html5ever), with a JS fast-path tree builder.** Targets every parse scenario and `new JSDOM`, and should give 3–6x on parse-heavy work.
   - html5ever emits a flat op buffer: `Uint32Array` of create/append/attribute ops plus a string table. Use one napi call per parse.
   - A JS loop builds impl nodes and links them directly through `treeHelpers` and private fields. While the subtree is detached it skips `_insert`, live ranges, mutation records, `_invalidateCaches`, ancestor walks, and the `remove()` and re-insert done by `_replaceAll`.
   - The JS loop then does a single `_insert` of the fragment root, or `_append` of the document children, and builds the document caches once.
   - Replacing parse5 alone, while keeping the per-node adapter callbacks, would save only about 15–20%.
   - Done properly, the result is about **3–6x** on all parse scenarios and `new JSDOM`.
2. **Faster computed style.** Targets RTL `getByRole`, `focus()`, and getComputedStyle.
   - Parse each rule's declarations once, at stylesheet insert time, into pre-expanded longhands. The cascade then copies values instead of calling `setProperty` and re-parsing with css-tree.
   - Index rules by id, class, and tag (a rule hash, as browsers do) instead of scanning linearly.
   - Pre-index the UA stylesheet once.
   - Add a cheap path for `display` and `visibility`, which is all that focusability and RTL `isInaccessible` need.
   - Cache inherited values per ancestor between mutations.
   - CSS value parsing and expansion can move to Rust (cssparser/lightningcss) through **one call per stylesheet or style attribute**.
   - Expected result: **10x+** on computed-style and focus, and **2–3x** on RTL.
3. **Selector matching on impls instead of wrappers, plus collection fixes.**
   - Make dom-selector, or a jsdom fast path for simple compound and descendant/child selectors, work on impl fields such as `_localName`, the attribute list, and `classList`.
   - Stop building whole-document `HTMLCollection`s inside querySelector.
   - Short-circuit the `Document` proxy named-property check, for example with a cheap `has` on a lazily built map that is not invalidated by non-named elements.
   - A Rust selector engine (servo `selectors`) only pays off if the tree is mirrored in Rust (recommendation 6), because callbacks into JS per node would cost too much.
   - Expected result: **3–10x** on the selector scenarios.
4. **Cheaper insert and remove bookkeeping, done in JS.** Targets the DOM API, React, cloneNode, and table sorting.
   - Make `_invalidateCaches` version bumps O(1). A document-level mutation counter would replace the per-ancestor walk.
   - Pass a known root or connected flag into `_insert` instead of calling `getRootNode()`/`isConnected` several times.
   - Skip `_shadowIncludingInclusiveDescendants` when the document has no custom elements, shadow roots, or insertion steps.
   - Make the named-property cache incremental.
   - `cloneNode` should build detached subtrees through the fast builder from recommendation 1.
   - Expected result: **2x** on create, clone, and sort, and a noticeable gain for React.
5. **Serializer.** Replace the parse5 serializer plus adapter with a direct impl-walking serializer in JS. It would avoid `childrenToArray` allocations, use precomputed qualified names, and escape in a single pass. Expected result: about **2–3x**. Serialization only becomes a Rust win with recommendation 6.
6. **Strategic: a Rust-side mirror of the DOM tree structure.** This would be an arena holding parent/child/sibling indices, local name, id, class set, and attributes, kept in sync from `_insert`, `_remove`, and attribute changes. It would:
   - turn querySelectorAll, matches, closest, getElementsBy*, serialization, and the cascade into single napi calls that return node indices
   - cost one napi call per mutation (about 30–60ns, acceptable)
   - be the main way to get **order-of-magnitude** gains on selector, style, and serialization workloads
   - be a large redesign, so do it after items 1–5.
7. **Keep in JS:** event dispatch, which is callback-bound; `table.rows`/`cells` and other generated-wrapper accessors, which mostly cost IDL wrapper overhead; and React's own work, which is 20–55% of the React scenarios. Generated IDL glue such as `implForWrapper`, `WrapperData`, and `getSameObject` is 10–40% on access-heavy scenarios. It can be sped up in JS, for example by caching collections in `[SameObject]` getters, but not with napi.
