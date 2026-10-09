"use strict";
// CPU-profile one scenario (measured iterations only, via the inspector Profiler in worker.js) and print
// aggregated hotspots.
//
//   node profile.js <scenario-substring> [--impl fork|fork-js|upstream] [--iters 5] [--warmup 2]
//                   [--sampling-us 100] [--top 40] [--json out.json] [--keep]
//
// Output sections:
//   1. self time by category (jsdom lib dir / npm package / GC / node internals)
//   2. top N functions by self time (function file:line)
//   3. top N jsdom-lib functions by inclusive (total) time, recursion counted once
//   4. top jsdom-lib files by self time
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { IMPLS, REPO_ROOT } = require("./lib/impls.js");
const scenarios = require("./scenarios/index.js");

function parseArgs(argv) {
  const args = { _: [] };
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
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function shortUrl(url) {
  if (!url) {
    return "";
  }
  let p = url;
  if (p.startsWith("file://")) {
    p = fileURLToPath(p);
  }
  const nm = p.lastIndexOf("/node_modules/");
  if (nm !== -1) {
    const rest = p.slice(nm + "/node_modules/".length);
    // upstream jsdom lives at bench-rs/node_modules/jsdom-upstream/lib/... — present it like the fork's lib/
    return rest.startsWith("jsdom-upstream/") ? rest.slice("jsdom-upstream/".length) : rest;
  }
  if (p.startsWith(`${REPO_ROOT}/`)) {
    return path.relative(REPO_ROOT, p);
  }
  return p;
}

function category(file, functionName) {
  if (!file) {
    if (functionName === "(garbage collector)") {
      return "GC";
    }
    if (functionName === "(program)" || functionName === "(idle)" || functionName === "(root)") {
      return functionName;
    }
    return "(native/builtin)";
  }
  if (file.startsWith("node:")) {
    return "node internals";
  }
  if (file.startsWith("lib/")) {
    const parts = file.split("/");
    // lib/jsdom/living/nodes/X.js -> lib/jsdom/living/nodes ; lib/generated/X -> lib/generated
    return parts.slice(0, Math.min(parts.length - 1, 4)).join("/");
  }
  if (file.startsWith("bench-rs/")) {
    return "bench-rs (scenario code)";
  }
  if (!file.startsWith("/")) {
    const parts = file.split("/");
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return "(other)";
}

function analyze(profiles) {
  const self = new Map(); // key -> { ms, file, line, fn }
  const incl = new Map(); // key -> ms
  const cats = new Map();
  const files = new Map();
  let total = 0;

  for (const prof of profiles) {
    const byId = new Map(prof.nodes.map(n => [n.id, n]));
    const nodeSelf = new Map();
    // samples landing in the inspector session's own post() (Profiler.start/stop bookkeeping) are not
    // scenario work
    const skip = new Set(prof.nodes.filter(n => n.callFrame.url === "node:inspector").map(n => n.id));
    for (let i = 0; i < prof.samples.length; i++) {
      if (skip.has(prof.samples[i])) {
        continue;
      }
      const dt = (prof.timeDeltas[i] || 0) / 1000;
      nodeSelf.set(prof.samples[i], (nodeSelf.get(prof.samples[i]) || 0) + dt);
      total += dt;
    }
    const info = new Map();
    for (const n of prof.nodes) {
      const cf = n.callFrame;
      const file = shortUrl(cf.url);
      const fn = cf.functionName || (file ? "(anonymous)" : "(unknown)");
      const key = file ? `${fn}  ${file}:${cf.lineNumber + 1}` : fn;
      info.set(n.id, { key, file, fn, line: cf.lineNumber + 1 });
      const ms = nodeSelf.get(n.id) || 0;
      if (ms) {
        const e = self.get(key) || { ms: 0, file, fn, line: cf.lineNumber + 1 };
        e.ms += ms;
        self.set(key, e);
        const c = category(file, fn);
        cats.set(c, (cats.get(c) || 0) + ms);
        if (file.startsWith("lib/")) {
          files.set(file, (files.get(file) || 0) + ms);
        }
      }
    }
    // inclusive: post-order subtree totals, credited to a key only at its outermost occurrence on the stack
    const onStack = new Map();
    const visit = id => {
      const n = byId.get(id);
      const { key } = info.get(id);
      onStack.set(key, (onStack.get(key) || 0) + 1);
      let sum = nodeSelf.get(id) || 0;
      for (const c of n.children || []) {
        sum += visit(c);
      }
      const depth = onStack.get(key);
      if (depth === 1) {
        incl.set(key, (incl.get(key) || 0) + sum);
      }
      onStack.set(key, depth - 1);
      return sum;
    };
    const root = prof.nodes[0].id;
    visit(root);
  }
  return { self, incl, cats, files, total };
}

function pct(ms, total) {
  return `${((100 * ms) / total).toFixed(1).padStart(5)}%`;
}

function report({ self, incl, cats, files, total }, top) {
  const lines = [];
  lines.push(`total sampled: ${total.toFixed(0)} ms\n`);
  lines.push("== self time by category ==");
  for (const [c, ms] of [...cats].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    lines.push(`${pct(ms, total)} ${ms.toFixed(0).padStart(7)} ms  ${c}`);
  }
  lines.push(`\n== top ${top} functions by self time ==`);
  for (const [key, e] of [...self].sort((a, b) => b[1].ms - a[1].ms).slice(0, top)) {
    lines.push(`${pct(e.ms, total)} ${e.ms.toFixed(0).padStart(7)} ms  ${key}`);
  }
  lines.push(`\n== top ${top} jsdom lib/ functions by inclusive time ==`);
  const libIncl = [...incl].filter(([k]) => k.includes("  lib/")).sort((a, b) => b[1] - a[1]).slice(0, top);
  for (const [key, ms] of libIncl) {
    lines.push(`${pct(ms, total)} ${ms.toFixed(0).padStart(7)} ms  ${key}`);
  }
  lines.push("\n== top jsdom lib/ files by self time ==");
  for (const [f, ms] of [...files].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    lines.push(`${pct(ms, total)} ${ms.toFixed(0).padStart(7)} ms  ${f}`);
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args._[0];
  if (!query) {
    console.error("usage: node profile.js <scenario> [--impl fork] [--iters 5] [--top 40] [--json out.json]");
    console.error(`scenarios:\n  ${scenarios.map(s => s.name).join("\n  ")}`);
    process.exit(2);
  }
  const scenario = scenarios.find(s => s.name === query) || scenarios.find(s => s.name.includes(query));
  if (!scenario) {
    throw new Error(`no scenario matches ${query}`);
  }
  const impl = args.impl || "fork";
  const top = Number(args.top || 40);
  const profDir = path.join(__dirname, "profiles");
  fs.mkdirSync(profDir, { recursive: true });
  const raw = path.join(profDir, `${scenario.name.replace(/\//gu, "_")}.${impl}.json`);

  const env = { ...process.env, ...IMPLS[impl].env };
  if (!IMPLS[impl].env.JSDOM_NATIVE) {
    delete env.JSDOM_NATIVE;
  }
  const r = spawnSync(process.execPath, [
    "--expose-gc", path.join(__dirname, "worker.js"), "--impl", impl, "--scenario", scenario.name,
    "--warmup", String(args.warmup ?? 2), "--iters", String(args.iters ?? 5), "--budget-ms", "600000",
    "--profile", raw, "--sampling-us", String(args["sampling-us"] ?? 100)
  ], { cwd: __dirname, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  const profiles = JSON.parse(fs.readFileSync(raw, "utf8"));
  const agg = analyze(profiles);
  console.log(`# ${scenario.name} [${impl}] — ${scenario.desc}`);
  console.log(`# ${profiles.length} measured iterations profiled\n`);
  console.log(report(agg, top));
  if (args.json) {
    const toObj = m => [...m].map(([k, v]) => ({ key: k, ms: typeof v === "number" ? v : v.ms }));
    fs.writeFileSync(String(args.json), JSON.stringify({
      scenario: scenario.name, impl, totalMs: agg.total,
      categories: toObj(agg.cats), self: toObj(agg.self).sort((a, b) => b.ms - a.ms).slice(0, 200),
      inclusive: toObj(agg.incl).sort((a, b) => b.ms - a.ms).slice(0, 200), files: toObj(agg.files)
    }, null, 2));
  }
  if (!args.keep) {
    fs.rmSync(raw);
  }
}

main();
