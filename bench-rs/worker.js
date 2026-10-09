"use strict";
// Runs ONE scenario against ONE impl in this process and prints a JSON result line.
//   node --expose-gc worker.js --impl fork --scenario divs/innerHTML [--warmup 3] [--iters 10]
//        [--budget-ms 30000] [--profile out.json] [--sampling-us 100]
const fs = require("node:fs");
const { IMPLS, nativeLoaded } = require("./lib/impls.js");

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
  const budgetMs = Number(args["budget-ms"] ?? 30000);
  const gc = typeof globalThis.gc === "function" ? globalThis.gc : () => {};

  const { JSDOM } = require(impl.modulePath());
  const ctx = { JSDOM, impl: implName };
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

  const times = [];
  const started = Date.now();
  for (let i = 0; i < warmup + iters; i++) {
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
    if (scenario.teardown) {
      await scenario.teardown(state);
    }
    if (measured) {
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
  const median = sorted.length % 2 ?
    sorted[(sorted.length - 1) / 2] :
    (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const result = {
    impl: implName,
    scenario: scenario.name,
    native: nativeLoaded(implName),
    warmup,
    times,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    // coefficient of variation; > 0.15 suggests interference (other processes, GC pressure)
    cv: Math.sqrt(times.reduce((a, t) => a + (t - median) ** 2, 0) / times.length) / median,
    rssMB: Math.round(process.memoryUsage().rss / 1048576)
  };
  process.stdout.write(`\n${MARKER}${JSON.stringify(result)}\n`);
  // jsdom windows/react may leave handles open; exit explicitly.
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});

