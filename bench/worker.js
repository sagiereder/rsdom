"use strict";
// Runs ONE scenario against ONE impl in this process and prints a JSON result line.
//   node --expose-gc worker.js --impl fork --scenario divs/innerHTML [--warmup 3] [--iters 10]
//        [--budget-ms 15000] [--profile out.json] [--sampling-us 100]
const fs = require("node:fs");
const { IMPLS, createDomFactory, nativeLoaded } = require("./lib/impls.js");

const MARKER = "__BENCH_RESULT__";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const implName = args.impl || "fork";
  const impl = IMPLS[implName];
  if (!impl) {
    throw new Error(`unknown impl ${implName}`);
  }
  const scenario = require("./scenarios/index.js").find(s => s.name === args.scenario);
  if (!scenario) {
    throw new Error(`unknown scenario ${args.scenario}`);
  }
  const warmup = Number(args.warmup ?? 3);
  const iters = Number(args.iters ?? 10);
  const budgetMs = Number(args["budget-ms"] ?? 15000);
  // Memory readings (a macrotask plus a full GC each) are taken on the first few timed iterations only.
  const memoryIters = 3;
  const gc = typeof globalThis.gc === "function" ? globalThis.gc : () => {};

  if (scenario.unsupported && scenario.unsupported[implName]) {
    // Not runnable on this impl (missing API); report N/A with the reason instead of failing.
    const result = { impl: implName, scenario: scenario.name, na: scenario.unsupported[implName] };
    process.stdout.write(`\n${MARKER}${JSON.stringify(result)}\n`);
    process.exit(0);
  }

  // The time budget covers prepare and warmups too: slow scenarios stop warming up (after at least one warmup) once half
  // of it is spent, and stop measuring (after at least three iterations) once all of it is.
  const started = Date.now();
  const ctx = { impl: implName, createDom: createDomFactory(implName) };
  const shared = scenario.prepare ? await scenario.prepare(ctx) : undefined;

  let session = null;
  const profiles = [];
  if (args.profile) {
    const inspector = require("node:inspector/promises");
    session = new inspector.Session();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: Number(args["sampling-us"] ?? 100) });
  }

  // Memory: JS heap + external (ArrayBuffers, native allocations reported to V8) still reachable after run, i.e. what
  // the document built so far costs while the test holds it, over a baseline taken before the first iteration (after
  // the impl is loaded and prepare's inputs are built). Read after a macrotask and a full GC, outside the timed region.
  // (Per-iteration "before" readings would be skewed: a closed window can stay reachable until the next one is made.)
  const heapNow = async () => {
    await new Promise(resolve => setImmediate(resolve));
    gc();
    const m = process.memoryUsage();
    return m.heapUsed + m.external;
  };
  const baseHeap = await heapNow();
  const times = [];
  const retained = [];
  let warmed = 0;
  for (let i = 0; i < warmup + iters; i++) {
    if (i < warmup && warmed >= 1 && Date.now() - started > budgetMs / 2) {
      i = warmup;
    }
    const measured = i >= warmup;
    const state = scenario.setup ? await scenario.setup(ctx, shared) : {};
    gc();
    if (measured && session) {
      await session.post("Profiler.start");
    }
    const t0 = process.hrtime.bigint();
    const ret = scenario.run(state);
    if (ret && typeof ret.then === "function") {
      await ret;
    }
    const t1 = process.hrtime.bigint();
    if (measured && session) {
      const { profile } = await session.post("Profiler.stop");
      profiles.push(profile);
    }
    if (measured && retained.length < memoryIters) {
      retained.push(await heapNow() - baseHeap);
    }
    if (scenario.teardown) {
      await scenario.teardown(state);
    }
    if (!measured) {
      warmed++;
    } else {
      times.push(Number(t1 - t0) / 1e6);
      if (times.length >= 3 && Date.now() - started > budgetMs) {
        break;
      }
    }
  }

  if (session) {
    fs.writeFileSync(args.profile, JSON.stringify(profiles));
    session.disconnect();
  }

  const sorted = [...times].sort((a, b) => a - b);
  const medianOf = xs => {
    const ys = [...xs].sort((a, b) => a - b);
    return ys.length % 2 ? ys[(ys.length - 1) / 2] : (ys[ys.length / 2 - 1] + ys[ys.length / 2]) / 2;
  };
  const median = medianOf(times);
  const result = {
    impl: implName,
    scenario: scenario.name,
    native: nativeLoaded(implName),
    warmup: warmed,
    times,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    // coefficient of variation; > 0.15 suggests interference (other processes, GC pressure)
    cv: Math.sqrt(times.reduce((a, t) => a + (t - median) ** 2, 0) / times.length) / median,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
    // Peak resident set size of the whole worker process (module load, warmups and all iterations).
    peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    retainedMB: Math.max(0, medianOf(retained)) / 1048576
  };
  process.stdout.write(`\n${MARKER}${JSON.stringify(result)}\n`);
  // DOM windows/react may leave handles open; exit explicitly.
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});

