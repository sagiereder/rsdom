# rsdom benchmarks

Full results of the benchmark suite in [`bench/`](bench/): every scenario, with timings and memory, for rsdom, jsdom 30.1.2 and happy-dom. The [README](README.md#benchmarks) has the per-area summary.

## Running

The benchmarks in `bench/` compare rsdom with the published jsdom 30.1.2 and [happy-dom](https://github.com/capricorn86/happy-dom). Each implementation and scenario runs in a fresh process. The scenarios cover simple divs and lists, large documents, huge tables, selectors, events, styles, and React apps (a dashboard and a complex multi-page app with forms, tables and modals, plus Testing Library, using React's development builds as Jest and Vitest do).

```sh
cd bench && npm install
node run.js --stat min              # jsdom vs rsdom vs happy-dom, the run behind the tables below; writes results/<timestamp>.json
node run.js --mode upstream         # jsdom vs rsdom only
node run.js --mode happy            # happy-dom vs rsdom
node run.js --quick --filter selectors
node report.js                      # rewrite the tables here and the README summary from the newest results file
```

Each scenario runs 3 warmups and up to 10 timed iterations within a 15-second budget per implementation (covering setup and warmups; at least 1 warmup and 3 timed iterations always run), and memory is read on the first 3 timed iterations. A full run takes about 40 minutes; `--quick` takes a few minutes.

rsdom is always benchmarked with its native addon; `run.js` refuses to report a run where the addon did not load.

## Results

<!-- BENCH:START -->
Measured 2026-10-13 on Apple M4 (darwin arm64), Node.js v24.21.0, rsdom at `52e8fb48`. Each number is the min of 10 timed iterations after 3 warmups, every scenario in a fresh process; a speedup is the other implementation's time / rsdom time (> 1 means rsdom is faster).

| Area | Scenario | jsdom 30.1.2 (ms) | happy-dom (ms) | rsdom (ms) | vs jsdom 30.1.2 | vs happy-dom |
|---|---|--:|--:|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 57.6 | 88.4 | 10.3 | 5.58x | 8.55x |
|  | `divs/innerHTML` | 200 | 162 | 39.5 | 5.06x | 4.10x |
|  | `lists/create-dom-api` | 52.7 | 83.3 | 14.0 | 3.75x | 5.93x |
|  | `lists/innerHTML` | 107 | 66.3 | 19.2 | 5.54x | 3.45x |
|  | `lists/query-iterate-read` | 103 | 121 | 40.8 | 2.53x | 2.98x |
| **Large documents** | `large/innerHTML-parse` | 322 | 249 | 46.4 | 6.94x | 5.36x |
|  | `large/jsdom-full-parse` | 253 | 268 | 48.2 | 5.24x | 5.56x |
|  | `large/serialize-outerHTML` | 74.0 | 154 | 20.8 | 3.55x | 7.42x |
|  | `large/serialize-dom` | 68.5 | 147 | 20.6 | 3.33x | 7.17x |
|  | `large/cloneNode-deep` | 219 | 232 | 20.8 | 10.6x | 11.2x |
| **Tables** | `tables/parse-innerHTML` | 365 | 330 | 62.5 | 5.84x | 5.27x |
|  | `tables/rows-cells-access` | 86.7 | 161 | 37.9 | 2.29x | 4.25x |
|  | `tables/nth-child-query` | 149 | 171 | 19.0 | 7.88x | 9.00x |
|  | `tables/sort-rows` | 115 | N/A | 28.0 | 4.10x | N/A |
|  | `tables/serialize` | 86.1 | 199 | 21.5 | 4.00x | 9.23x |
| **Selectors** | `selectors/complex-qsa` | 78.8 | 48.3 | 9.45 | 8.33x | 5.11x |
|  | `selectors/querySelector-many` | 866 | 218 | 73.8 | 11.7x | 2.95x |
|  | `selectors/live-collections` | 69.3 | 221 | 7.46 | 9.29x | 29.6x |
|  | `selectors/matches-closest` | 72.1 | 17.1 | 4.03 | 17.9x | 4.26x |
| **Events and style** | `events/bubble-deep` | 82.2 | 86.9 | 40.9 | 2.01x | 2.12x |
|  | `events/many-targets-delegation` | 952 | 14.6 | 10.3 | 92.6x | 1.42x |
|  | `style/inline-set` | 98.8 | 279 | 47.5 | 2.08x | 5.87x |
|  | `style/computed-style` | 1246 | 190 | 42.7 | 29.2x | 4.46x |
|  | `style/css-in-js-inject` | 275 | 167 | 54.7 | 5.02x | 3.06x |
|  | `style/css-in-js-insertRule` | 674 | 394 | 115 | 5.87x | 3.44x |
|  | `style/computed-after-mutation` | 765 | 248 | 92.9 | 8.24x | 2.67x |
| **React** | `react/render-dashboard` | 46.7 | 68.0 | 30.1 | 1.55x | 2.26x |
|  | `react/updates` | 166 | 209 | 128 | 1.30x | 1.64x |
|  | `react/unmount` | 37.9 | 75.9 | 11.8 | 3.20x | 6.41x |
|  | `react/complex-app` | 801 | 1184 | 521 | 1.54x | 2.27x |
|  | `react/testing-library-form` | 265 | 124 | 82.9 | 3.20x | 1.50x |
| **Accessibility queries and user-event** | `a11y/getByRole-page` | 1457 | 632 | 144 | 10.1x | 4.40x |
|  | `a11y/user-event-flow` | 290 | 153 | 140 | 2.07x | 1.09x |
| **Web components** | `webcomponents/shadow-render` | 138 | 66.5 | 45.0 | 3.07x | 1.48x |
| **Mutation observers** | `mutation/observed-updates` | 178 | 211 | 132 | 1.35x | 1.60x |
|  | `mutation/synthetic-10k` | 89.1 | 50.1 | 47.0 | 1.89x | 1.06x |
| **Template rendering** | `template/clone-render` | 104 | 121 | 21.2 | 4.91x | 5.73x |
|  | `template/lit-render` | 119 | 156 | 29.0 | 4.09x | 5.37x |
| **Forms** | `forms/big-form` | 244 | 443 | 61.2 | 3.98x | 7.24x |
| **Window startup** | `startup/window-per-test` | 387 | 376 | 271 | 1.43x | 1.39x |
|  | `startup/window-per-test-scripts` | 355 | 395 | 282 | 1.26x | 1.40x |
| **Real page parsing** | `parse/real-page` | 39.6 | 22.4 | 7.09 | 5.59x | 3.16x |
|  | `parse/real-page-serialize` | 49.2 | 65.6 | 30.8 | 1.60x | 2.13x |
|  | `parse/real-page-selectors` | 59.6 | 26.8 | 8.27 | 7.21x | 3.24x |
| **XML and SVG** | `xml/domparser-svg` | 71.7 | N/A | 11.7 | 6.12x | N/A |
|  | `xml/serializer-roundtrip` | 182 | N/A | 90.0 | 2.02x | N/A |
|  | `xml/getElementsByTagNameNS` | 128 | N/A | 73.5 | 1.74x | N/A |
|  | **Geometric mean** |  |  |  | **4.29x** | **3.70x** |

### Memory

**Retained heap** is the JS heap plus external memory still reachable after the scenario ran (the document is still held, as a test would hold it), over a baseline taken after the implementation was loaded; it is read after a full GC, as the median over the first three timed iterations. **Peak RSS** is the worker process's maximum resident set size over the whole run, including module loading and warmups, so it also reflects garbage the GC had not yet reclaimed. Lower is better. The multiplier next to a jsdom or happy-dom number is how many times rsdom's it is (shown where both retain at least 1 MB).

| Area | Scenario | jsdom 30.1.2 retained (MB) | happy-dom retained (MB) | rsdom retained (MB) | jsdom 30.1.2 peak RSS (MB) | happy-dom peak RSS (MB) | rsdom peak RSS (MB) |
|---|---|--:|--:|--:|--:|--:|--:|
| **Simple divs and lists** | `divs/create-dom-api` | 53.5 (3.07x) | 174 (9.99x) | 17.4 | 591 (3.03x) | 440 (2.26x) | 195 |
|  | `divs/innerHTML` | 63.5 (2.75x) | 227 (9.83x) | 23.1 | 711 (2.68x) | 505 (1.91x) | 265 |
|  | `lists/create-dom-api` | 38.3 (1.90x) | 123 (6.13x) | 20.1 | 451 (1.92x) | 366 (1.56x) | 235 |
|  | `lists/innerHTML` | 30.9 (2.61x) | 111 (9.35x) | 11.8 | 456 (2.61x) | 360 (2.06x) | 175 |
|  | `lists/query-iterate-read` | 178 (7.34x) | 133 (5.47x) | 24.3 | 544 (1.52x) | 489 (1.37x) | 357 |
| **Large documents** | `large/innerHTML-parse` | 103 (3.11x) | 373 (11.3x) | 33.1 | 984 (2.91x) | 692 (2.05x) | 338 |
|  | `large/jsdom-full-parse` | 103 (3.12x) | 373 (11.3x) | 33.0 | 958 (2.68x) | 690 (1.93x) | 357 |
|  | `large/serialize-outerHTML` | 103 (3.26x) | 374 (11.9x) | 31.5 | 971 (2.96x) | 1049 (3.20x) | 328 |
|  | `large/serialize-dom` | 103 (3.26x) | 374 (11.9x) | 31.5 | 971 (2.95x) | 1049 (3.19x) | 329 |
|  | `large/cloneNode-deep` | 201 (3.56x) | 749 (13.3x) | 56.5 | 1668 (4.51x) | 1526 (4.12x) | 370 |
| **Tables** | `tables/parse-innerHTML` | 133 (3.39x) | 470 (12.0x) | 39.3 | 1243 (3.43x) | 819 (2.26x) | 362 |
|  | `tables/rows-cells-access` | 145 (1.47x) | 493 (4.98x) | 98.9 | 1263 (2.26x) | 1316 (2.36x) | 558 |
|  | `tables/nth-child-query` | 357 (8.20x) | 523 (12.0x) | 43.6 | 1482 (2.46x) | 1356 (2.25x) | 602 |
|  | `tables/sort-rows` | 146 (0.79x) | N/A | 185 | 1281 (2.10x) | N/A | 610 |
|  | `tables/serialize` | 141 (3.15x) | 481 (10.7x) | 44.9 | 1252 (3.00x) | 1298 (3.11x) | 418 |
| **Selectors** | `selectors/complex-qsa` | 51.3 (6.12x) | 67.3 (8.02x) | 8.39 | 392 (2.01x) | 344 (1.76x) | 195 |
|  | `selectors/querySelector-many` | 26.0 (3.02x) | 74.2 (8.60x) | 8.63 | 405 (2.33x) | 358 (2.06x) | 174 |
|  | `selectors/live-collections` | 24.2 (0.96x) | 76.2 (3.03x) | 25.2 | 381 (2.19x) | 356 (2.05x) | 174 |
|  | `selectors/matches-closest` | 25.3 (2.83x) | 67.0 (7.48x) | 8.96 | 389 (2.24x) | 360 (2.07x) | 174 |
| **Events and style** | `events/bubble-deep` | 3.73 (1.01x) | 1.61 (0.44x) | 3.68 | 189 (1.08x) | 118 (0.67x) | 175 |
|  | `events/many-targets-delegation` | 22.9 (1.04x) | 9.23 (0.42x) | 22.0 | 306 (1.49x) | 188 (0.91x) | 206 |
|  | `style/inline-set` | 20.5 (0.74x) | 32.2 (1.16x) | 27.7 | 370 (1.21x) | 301 (0.98x) | 306 |
|  | `style/computed-style` | 46.4 (1.02x) | 40.6 (0.89x) | 45.6 | 393 (1.35x) | 281 (0.96x) | 292 |
|  | `style/css-in-js-inject` | 38.7 (0.99x) | 33.8 (0.87x) | 39.0 | 334 (1.14x) | 262 (0.90x) | 292 |
|  | `style/css-in-js-insertRule` | 29.5 (0.94x) | 56.8 (1.81x) | 31.5 | 334 (1.10x) | 294 (0.96x) | 305 |
|  | `style/computed-after-mutation` | 20.1 (0.60x) | 24.6 (0.74x) | 33.3 | 309 (1.10x) | 272 (0.97x) | 281 |
| **React** | `react/render-dashboard` | 18.6 (0.91x) | 43.7 (2.13x) | 20.5 | 259 (1.29x) | 277 (1.39x) | 200 |
|  | `react/updates` | 21.0 (0.92x) | 44.8 (1.96x) | 22.9 | 331 (1.19x) | 439 (1.58x) | 277 |
|  | `react/unmount` | 5.78 (0.42x) | 3.85 (0.28x) | 13.8 | 506 (1.29x) | 1014 (2.59x) | 392 |
|  | `react/complex-app` | 2.51 (0.22x) | 2.27 (0.20x) | 11.4 | 540 (1.31x) | 896 (2.18x) | 411 |
|  | `react/testing-library-form` | 14.8 (0.56x) | 8.71 (0.33x) | 26.3 | 291 (1.08x) | 248 (0.92x) | 269 |
| **Accessibility queries and user-event** | `a11y/getByRole-page` | 70.5 (1.49x) | 132 (2.78x) | 47.4 | 479 (1.42x) | 449 (1.33x) | 337 |
|  | `a11y/user-event-flow` | 18.5 (0.79x) | 7.83 (0.34x) | 23.3 | 298 (1.17x) | 272 (1.07x) | 254 |
| **Web components** | `webcomponents/shadow-render` | 62.4 (2.89x) | 64.5 (2.98x) | 21.6 | 451 (1.58x) | 310 (1.08x) | 286 |
| **Mutation observers** | `mutation/observed-updates` | 35.6 (1.56x) | 46.4 (2.03x) | 22.8 | 379 (1.38x) | 441 (1.60x) | 275 |
|  | `mutation/synthetic-10k` | 4.28 (1.10x) | 2.60 (0.67x) | 3.87 | 265 (1.12x) | 247 (1.05x) | 236 |
| **Template rendering** | `template/clone-render` | 132 (12.3x) | 98.7 (9.18x) | 10.7 | 476 (2.57x) | 345 (1.86x) | 185 |
|  | `template/lit-render` | 2.53 (1.32x) | 4.79 (2.50x) | 1.91 | 276 (1.23x) | 914 (4.08x) | 224 |
| **Forms** | `forms/big-form` | 10.7 (1.65x) | 50.8 (7.87x) | 6.45 | 292 (1.66x) | 321 (1.82x) | 176 |
| **Window startup** | `startup/window-per-test` | 10.2 (2.87x) | 0.77 | 3.56 | 1778 (3.77x) | 252 (0.53x) | 472 |
|  | `startup/window-per-test-scripts` | 10.8 (1.52x) | 0.99 | 7.08 | 2039 (2.77x) | 239 (0.32x) | 736 |
| **Real page parsing** | `parse/real-page` | 15.8 (1.09x) | 31.4 (2.17x) | 14.4 | 266 (1.55x) | 247 (1.44x) | 172 |
|  | `parse/real-page-serialize` | 14.1 (0.96x) | 31.7 (2.17x) | 14.6 | 330 (1.60x) | 311 (1.51x) | 206 |
|  | `parse/real-page-selectors` | 60.8 (4.08x) | 36.2 (2.43x) | 14.9 | 334 (1.72x) | 301 (1.55x) | 194 |
| **XML and SVG** | `xml/domparser-svg` | 3.07 | N/A | 0.00 | 276 (1.78x) | N/A | 155 |
|  | `xml/serializer-roundtrip` | 28.6 (2.34x) | N/A | 12.2 | 310 (1.18x) | N/A | 262 |
|  | `xml/getElementsByTagNameNS` | 22.3 (4.79x) | N/A | 4.65 | 297 (1.18x) | N/A | 252 |

jsdom 30.1.2 retains **1.78x** as much heap as rsdom (geometric mean over the 46 scenarios where both keep at least 1 MB) and peaks at **1.81x** its RSS; happy-dom retains **2.92x** as much heap as rsdom (geometric mean over the 41 scenarios where both keep at least 1 MB) and peaks at **1.56x** its RSS.

Regenerate these tables with `node bench/report.js` after a full `node bench/run.js`.
<!-- BENCH:END -->

Notes on happy-dom 20.14.6: `tables/sort-rows` needs `HTMLTableSectionElement.rows`, which it doesn't implement. In `selectors/complex-qsa` it returns wrong results (`:enabled` matches nothing, and a sibling-combinator query returns duplicates). In `style/computed-style` it does less work (values such as colours and `calc()` are not resolved).

## Real test suites

[`bench/real-suites/`](bench/real-suites/README.md) runs the real Jest and Vitest suites of six open-source React projects (react-hook-form, downshift, mantine, radix-primitives, ariakit, react-redux), pinned to fixed commits. It runs them with each project's own jsdom, jsdom 30.1.2, rsdom and happy-dom, and compares wall time and per-test results. It also has a CPU-profile breakdown and a measurement of animation-frame waits.
