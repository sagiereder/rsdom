# Real-suite benchmark

Runs the real test suites of open-source React projects with four DOM implementations and compares wall time and per-test results:

| Impl | What it is |
|---|---|
| `jsdom` | the project's own jsdom version and test environment, untouched |
| `jsdom30` | upstream jsdom 30.1.2 (rsdom's base) through rsdom's own Jest/Vitest integration code: the compatibility reference for rsdom |
| `rsdom` | this worktree (`../../`), native build only; the harness refuses to run if the native addon does not load |
| `happy-dom` | happy-dom through the runner's own happy-dom environment; its failures are reported, never hidden |

Differences between a project's older jsdom and jsdom 30.1.2 are jsdom version changes, not rsdom bugs, so rsdom's regressions are counted against `jsdom30`.

## Projects

Each project is cloned at a pinned commit into `.cache/` (gitignored) by `setup`. See [`manifest.js`](manifest.js) for commands and per-project notes.

| Project | Runner | Commit | Suite |
|---|---|---|---|
| [react-hook-form](https://github.com/react-hook-form/react-hook-form) | Jest 30 | `7ba651ab94586fb723d10daf0dfd8e351f5f0834` | whole suite |
| [downshift](https://github.com/downshift-js/downshift) | Jest 29 | `1bb8b75e506fe807a5c5201a103d1bd128e5a5e2` | whole suite |
| [mantine](https://github.com/mantinedev/mantine) | Jest 30 | `e243f7f999b3250c0babe6c6aa6dba9bcb4aa836` | `packages/@mantine/core` |
| [radix-primitives](https://github.com/radix-ui/primitives) | Vitest 4 | `e46b65900b0c8243dad96dae0f1d44321fa1ff72` | whole suite |
| [ariakit](https://github.com/ariakit/ariakit) | Vitest 5 | `88a92295093065502b6b9db2554f040cf9997a11` | `react` + `dom` projects |
| [react-redux](https://github.com/reduxjs/react-redux) | Vitest 4 | `14ef3ca025048e3dcf1d87af64ff71b94571a471` | whole suite |

## Running

```sh
cd bench/real-suites && npm install
node run.js setup                                   # clone + install every project, write the wrapper configs
node run.js bench --runs 3 --warmups 1              # all projects x all impls; writes results/<timestamp>.json
node run.js bench --only radix-primitives,ariakit --impls jsdom30,rsdom
node run.js profile --only ariakit --impl rsdom     # CPU-profiles every process of one run, prints a breakdown
node run.js analyze --only ariakit --impl rsdom     # re-analyzes the last profile run's .cpuprofile files
node run.js frames --only ariakit                   # Vitest: share of test-file time with a rAF callback pending
node run.js report [results/a.json results/b.json]  # markdown table; later files win per project
```

How the environment is swapped: `setup` writes a wrapper config next to each project's own (Jest or Vitest) that loads the original config and replaces only its test environment, chosen by `REAL_SUITES_IMPL` ([`lib/swap.mjs`](lib/swap.mjs), [`lib/jest-env.cjs`](lib/jest-env.cjs), [`lib/vitest-env.mjs`](lib/vitest-env.mjs), [`envs/`](envs/)). Every impl runs the same command with the same runner flags (`--maxWorkers=4`, JSON reporter). Each round runs the impls in a rotated order; the table reports the min over the timed rounds (the JSON also has every run and the median). A run that exceeds 20 minutes is killed with its whole process group.

## Results

<!-- RESULTS:START -->
Measured 2026-10-13 on an Apple M4 (10 cores, macOS), Node.js v24.21.0, rsdom at `d5f8962e`, `--maxWorkers=4`. Each number is the min wall time in seconds over 3 timed rounds after 1 warmup (mantine: 5 rounds, re-run because its first 3 rounds were too noisy). Speedup = other impl's time / rsdom's time, so above 1 means rsdom is faster. Other agents were running builds and tests on the same machine (load average 2–12), so treat differences under about 5% as noise. Sources: `results/2026-10-13T13-10-22-437Z.json` and `results/2026-10-13T15-51-22-461Z.json` (mantine), merged with `node run.js report <both>`.

| Project | Runner | Project's jsdom | jsdom (s) | jsdom 30.1.2 (s) | rsdom (s) | happy-dom (s) | rsdom speedup vs jsdom / jsdom 30 | rsdom vs happy-dom | Tests passed: jsdom / jsdom 30 / rsdom / happy-dom | rsdom regressions vs jsdom 30 |
|---|---|---|--:|--:|--:|--:|--:|--:|---|--:|
| [react-hook-form](https://github.com/react-hook-form/react-hook-form/tree/7ba651ab94) | jest 30.4.2 | 26.1.0 | 3.6 | 3.8 | 3.1 | 4.3 | 1.17x / 1.22x | 1.39x | 1531 / 1531 / 1531 / 1525 (6 failed) | 0 |
| [downshift](https://github.com/downshift-js/downshift/tree/1bb8b75e50) | jest 29.7.0 | 20.0.3 | 3.7 | 4.0 | 2.9 | 2.9 | 1.30x / 1.40x | 1.01x | 1110 / 1102 (8 failed) / 1102 (8 failed) / 1091 (19 failed) | 0 |
| [mantine](https://github.com/mantinedev/mantine/tree/e243f7f999) | jest 30.5.2 | 26.1.0 | 37.7 | 39.9 | 34.0 | 37.7 | 1.11x / 1.18x | 1.11x | 10660 / 10077 (583 failed) / 10077 (583 failed) / 9428 (1232 failed) | 0 |
| [radix-primitives](https://github.com/radix-ui/primitives/tree/e46b65900b) | vitest 4.1.7 | 29.1.1 | 11.6 | 11.2 | 9.9 | 7.5 | 1.18x / 1.14x | 0.76x | 1144 / 1144 / 1144 / 1126 (18 failed) | 0 |
| [ariakit](https://github.com/ariakit/ariakit/tree/88a9229509) | vitest 5.0.3 | 30.1.2 | 225.3 | 225.3 | 216.0 | 101.2 | 1.04x / 1.04x | 0.47x | 1818 (41 failed) / 1818 (41 failed) / 1818 (41 failed) / 1859 | 0 |
| [react-redux](https://github.com/reduxjs/react-redux/tree/14ef3ca025) | vitest 4.1.11 | 25.0.1 | 2.8 | 3.4 | 2.7 | 2.4 | 1.01x / 1.23x | 0.89x | 141 / 141 / 141 / 141 | 0 |
<!-- RESULTS:END -->

### Compatibility

rsdom fails no test that jsdom 30.1.2 passes on any of the six projects. The other differences in the table:

- **downshift** (jsdom 20 → 30): 8 tests fail with both jsdom 30.1.2 and rsdom: 4 `setA11yStatus` tests, 3 `scrollIntoView` tests and one `getInputProps` blur test. These are jsdom version changes.
- **mantine** (jsdom 26 → 30): 583 tests fail with both jsdom 30.1.2 and rsdom, nearly all `toHaveStyle` assertions affected by jsdom 30's CSSOM changes.
- **ariakit**: 41 tests fail with every jsdom, including the project's own jsdom 30.1.2. Ariakit's own CI uses happy-dom, and it passes all of them.
- **mantine, one rsdom warmup run**: a Jest worker died with SIGSEGV inside V8's garbage collector (`ClearStaleLeftTrimmedPointerVisitor` during `InternalFrame::Iterate`), so one test file did not run. This is not an rsdom crash: the macOS crash reports show the same V8 stack in four other Node processes on this machine that never loaded rsdom's native addon. None of the timed rounds crashed.
- **happy-dom** fails tests in 5 of 6 projects: react-hook-form 6, downshift 19, mantine 1232, radix 18. It passes every ariakit test.

### Where the time goes (rsdom, CPU profiles)

`profile` CPU-profiles every process (`--cpu-prof` through a `--require` hook) and attributes self time by script URL. Results: [`results/profile-*.json`](results/).

| Category | ariakit | radix-primitives | react-redux |
|---|--:|--:|--:|
| React | 21.2% | 7.6% | 7.2% |
| DOM (rsdom code) | 18.5% | 21.7% | 11.7% |
| DOM: loading its own modules (fs + compile) | 16.4% | (in node core) | (in node core) |
| project code + other libraries | 13.1% | 2.2% | 3.1% |
| node core (module loading, fs, …) | 9.7% | 52.5% | 60.3% |
| transform/compile | 8.1% | 2.4% | 3.1% |
| test runner | 6.5% | 4.7% | 5.8% |
| GC | 4.0% | 4.6% | 6.1% |
| Testing Library | 1.5% | 3.5% | 1.9% |

The DOM share by area, as a share of all CPU time:

| DOM area | ariakit | radix-primitives | react-redux |
|---|--:|--:|--:|
| window setup/teardown | 8.8% | 10.6% | 6.7% |
| style/getComputedStyle | 4.1% | 5.3% | 1.7% |
| tree ops | 2.5% | 1.9% | 0.8% |
| events | 1.1% | 1.3% | 0.4% |
| selectors | 0.8% | 0.6% | 0.2% |
| parsing/serialization | 0.0% | 0.4% | 0.0% |
| mutation observers | 0.1% | 0.1% | 0.0% |

The radix and react-redux profiles were taken before the analyzer split rsdom's module loading out of "node core". Their "node core" share is mostly the cold module load of every Vitest fork: the forks pool starts a fresh process per test file, so each file pays for loading the DOM, React and the runner and for setting up its first window. The single most expensive DOM function in all three suites is `installInterfaces` (creating every interface for a new window), at 1.7–4% of CPU. Next is the first `getComputedStyle` in a process: it parses the UA stylesheet and loads css-tree, css-color and dom-selector.

### Ariakit is bound by animation frames

Ariakit's test helpers wait for real frames (`await new Promise(requestAnimationFrame)` in `settle()` and `sleep()`, `packages/ariakit-test/src/__utils.ts`). With `pretendToBeVisual`, jsdom and rsdom run `requestAnimationFrame` on a 60 Hz timer, so these tests sit idle for most of their wall time. `frames` measures it. It wraps `requestAnimationFrame` in the test environment and records, per test file, how long at least one frame callback was pending. Results: [`results/frames-*.json`](results/).

| Suite | Impl | rAF calls | Test-file time | With a frame pending | Share |
|---|---|--:|--:|--:|--:|
| ariakit | jsdom 30.1.2 | 61,222 | 883 s | 591 s | 67.0% |
| ariakit | rsdom | 61,216 | 974 s | 568 s | 58.3% |
| radix-primitives | jsdom 30.1.2 | 544 | 38.1 s | 4.0 s | 10.6% |
| radix-primitives | rsdom | 546 | 42.0 s | 3.5 s | 8.4% |
| react-redux | both | 0 | – | 0 | 0% |

The frames run was taken under heavy machine load (load average around 12), which inflates absolute times. The share and the call counts are the useful numbers. With the happy-dom environment wrapped this way, ariakit collected fewer tests and made only 18 rAF calls, so `frames` leaves happy-dom out by default; those rows in the committed frames JSON are not comparable. Ariakit's CPU profile agrees with the frame data: 428 s of CPU over 318 s of wall time on 4 workers means the workers were idle about two thirds of the time. This is why ariakit gains only about 1.04x from rsdom while happy-dom, whose rAF does not wait for a 60 Hz cadence, is about 2.1x faster than rsdom (its rAF runs callbacks on the next macrotask).

A faster or virtual frame clock would remove most of ariakit's wall time, but it is not implemented. The 60 Hz cadence is observable behaviour that jsdom users rely on: rAF timestamps, ordering against timers, and interaction with fake timers. Changing it is a product decision, not a benchmark fix.

### Optimization candidates, ranked by expected effect on these suites

1. **First `getComputedStyle` per process.** Load the UA stylesheet precompiled (or from Rust), and load css-tree, css-color and dom-selector lazily or replace them. Measured cold cost: about 73 ms per process, paid by every Vitest fork that touches style.
2. **`installInterfaces` per window** (1.7–4% of CPU). Install interfaces lazily, or snapshot and clone the prototype setup.
3. **Module-load cost per fork.** Bundle rsdom's `lib/` into fewer files, or use Node's compile cache. The ariakit profile attributes 16% of CPU to loading rsdom's own modules.
4. **rAF cadence** (behaviour change, a user decision): see above. This is by far the largest wall-time lever for frame-bound suites like ariakit.

Already done on this branch: undici and the dispatcher stack now load only when a window first needs the network (`d5f8962e`). A/B over 6 alternating runs, rsdom only, mean wall time: radix 12.75 s → 12.55 s, react-redux 2.82 s → 2.72 s.
