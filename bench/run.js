"use strict";
// Benchmark driver. Every (impl, scenario) pair runs in a fresh child process (worker.js).
//
//   node run.js                       upstream jsdom@30.1.2 vs fork-js vs fork (native on) vs happy-dom
//   node run.js --mode upstream       upstream vs fork
//   node run.js --mode native         fork-js (JSDOM_NATIVE=0) vs fork (native on)
//   node run.js --mode happy          happy-dom vs fork
//   node run.js --impls upstream,fork custom impl list (first one is the baseline for ratios)
// Ratio columns are speedups (other ms / impl ms, > 1 = faster): every impl vs the baseline, plus "fork/happy"
// (fork vs happy-dom) whenever both are in the list. Scenarios an impl cannot run are reported as N/A.
//   --filter <substr>  only scenarios whose name contains substr (comma-separated list = OR)
//   --quick            1 warmup + 3 measured iterations, 8s budget per pair
//   --warmup N --iters N --budget-ms N   override iteration counts / per-pair time budget
//   --stat min         compare by fastest iteration instead of median (more robust on a loaded machine)
//   --no-save          do not write results/<timestamp>.json
//   --out <file>       write results to this path instead
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { IMPLS, REPO_ROOT } = require("./lib/impls.js");
const scenarios = require("./scenarios/index.js");

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

const MODES = {
  upstream: ["upstream", "fork"],
  native: ["fork-js", "fork"],
  all: ["upstream", "fork-js", "fork", "happy-dom"],
  happy: ["happy-dom", "fork"]
};

const SHORT = { "upstream": "up", "happy-dom": "happy" };

function fmtMs(ms) {
  if (ms === undefined || Number.isNaN(ms)) {
    return "—";
  }
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(1);
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

function gitRev() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runPair(impl, scenario, opts) {
  const workerArgs = [
    "--expose-gc", path.join(__dirname, "worker.js"),
    "--impl", impl, "--scenario", scenario.name,
    "--warmup", String(opts.warmup), "--iters", String(opts.iters), "--budget-ms", String(opts.budgetMs)
  ];
  const env = { ...process.env, ...IMPLS[impl].env };
  if (!IMPLS[impl].env.JSDOM_NATIVE) {
    delete env.JSDOM_NATIVE;
  }
  const r = spawnSync(process.execPath, workerArgs, {
    cwd: __dirname, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024
  });
  const line = (r.stdout || "").split("\n").find(l => l.startsWith(MARKER));
  if (r.status !== 0 || !line) {
    return { impl, scenario: scenario.name, error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").slice(0, 8).join("\n") };
  }
  return JSON.parse(line.slice(MARKER.length));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const impls = args.impls ? String(args.impls).split(",") : MODES[args.mode || "all"];
  if (!impls || impls.some(i => !IMPLS[i])) {
    throw new Error(`bad --mode/--impls; impls are ${Object.keys(IMPLS).join(", ")}; modes are ${Object.keys(MODES).join(", ")}`);
  }
  const quick = Boolean(args.quick);
  const opts = {
    warmup: Number(args.warmup ?? (quick ? 1 : 3)),
    iters: Number(args.iters ?? (quick ? 3 : 10)),
    budgetMs: Number(args["budget-ms"] ?? (quick ? 8000 : 30000))
  };
  const stat = args.stat === "min" ? "min" : "median";
  const filters = args.filter ? String(args.filter).split(",") : null;
  const selected = scenarios.filter(s => !filters || filters.some(f => s.name.includes(f)));
  if (selected.length === 0) {
    throw new Error(`no scenario matches --filter ${args.filter}`);
  }

  const baseline = impls[0];
  // ratio columns: [key, numerator impl (the slower reference), denominator impl]; value = ref ms / impl ms
  const ratioCols = impls.slice(1).map(i => ({ key: `${i}/${baseline}`, label: `${i}/${SHORT[baseline] || baseline}`, ref: baseline, impl: i }));
  if (impls.includes("fork") && impls.includes("happy-dom") && baseline !== "happy-dom") {
    ratioCols.push({ key: "fork/happy-dom", label: "fork/happy", ref: "happy-dom", impl: "fork" });
  }
  const nameW = Math.max(...selected.map(s => s.name.length), 8) + 3;
  const colW = Math.max(11, ...impls.map(i => i.length + 5));
  const header = pad("scenario", nameW) +
    impls.map(i => pad(`${i} ms`, colW, true)).join("") +
    ratioCols.map(c => pad(c.label, colW + 2, true)).join("");
  console.log(`impls: ${impls.map(i => `${i} (${IMPLS[i].desc})`).join(", ")}`);
  console.log(`warmup=${opts.warmup} iters=${opts.iters} budget=${opts.budgetMs}ms per (impl, scenario); ` +
    `ratio a/b = b ${stat} / a ${stat} (> 1: a is faster)\n`);
  console.log(header);
  console.log("-".repeat(header.length));

  const rows = [];
  const notes = [];
  for (const scenario of selected) {
    const results = {};
    for (const impl of impls) {
      results[impl] = runPair(impl, scenario, opts);
    }
    const ratios = {};
    for (const c of ratioCols) {
      const a = results[c.impl][stat];
      const b = results[c.ref][stat];
      ratios[c.key] = a && b ? b / a : NaN;
    }
    const speedups = {};
    for (const impl of impls.slice(1)) {
      speedups[impl] = ratios[`${impl}/${baseline}`];
    }
    const caveats = scenario.caveats ? Object.fromEntries(Object.entries(scenario.caveats).filter(([i]) => impls.includes(i))) : {};
    rows.push({ scenario: scenario.name, group: scenario.group, desc: scenario.desc, results, speedups, ratios, caveats });
    const cell = r => (r.na ? "N/A " : r.error ? "ERR " : fmtMs(r[stat]) + (r.cv > 0.15 ? "~" : " "));
    const mark = Object.keys(caveats).length ? "*" : "";
    console.log(pad(scenario.name + mark, nameW) +
      impls.map(i => pad(cell(results[i]), colW, true)).join("") +
      ratioCols.map(c => pad(Number.isNaN(ratios[c.key]) ? "—" : `${ratios[c.key].toFixed(2)}x`, colW + 2, true)).join(""));
    for (const impl of impls) {
      if (results[impl].error) {
        console.log(`  ! ${impl} failed:\n${results[impl].error.replace(/^/gmu, "    ")}`);
      } else if (results[impl].na) {
        notes.push(`${scenario.name} [${impl}]: N/A — ${results[impl].na}`);
      }
    }
    for (const [impl, note] of Object.entries(caveats)) {
      notes.push(`${scenario.name}* [${impl}]: ${note}`);
    }
  }

  // geometric mean per ratio column, over scenarios where both sides ran
  console.log("-".repeat(header.length));
  const geomeans = {};
  for (const c of ratioCols) {
    const vals = rows.map(r => r.ratios[c.key]).filter(v => Number.isFinite(v) && v > 0);
    geomeans[c.key] = vals.length ? Math.exp(vals.reduce((a, v) => a + Math.log(v), 0) / vals.length) : NaN;
  }
  const geo = {};
  for (const impl of impls.slice(1)) {
    geo[impl] = geomeans[`${impl}/${baseline}`];
  }
  console.log(pad("geomean", nameW) + " ".repeat(colW * impls.length) +
    ratioCols.map(c => pad(Number.isNaN(geomeans[c.key]) ? "—" : `${geomeans[c.key].toFixed(2)}x`, colW + 2, true)).join(""));
  const nativeFlags = impls.filter(i => IMPLS[i].kind === "jsdom")
    .map(i => `${i}=${rows.some(r => r.results[i].native) ? "native" : "js"}`);
  console.log("(~ = noisy: spread around the median > 15%; re-run with --filter to confirm. " +
    "* = an impl diverges from jsdom, see notes)");
  for (const n of notes) {
    console.log(n);
  }
  console.log(`\nnative addon loaded: ${nativeFlags.join(", ")}`);

  if (!args["no-save"]) {
    const out = args.out ?
      path.resolve(String(args.out)) :
      path.join(__dirname, "results", `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      date: new Date().toISOString(),
      gitRev: gitRev(),
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpu: os.cpus()[0] && os.cpus()[0].model,
      impls,
      implDescs: Object.fromEntries(impls.map(i => [i, IMPLS[i].desc])),
      baseline,
      ratioColumns: ratioCols.map(c => c.key),
      opts,
      stat,
      geomeanSpeedup: geo,
      geomeanRatios: geomeans,
      rows
    }, null, 2));
    console.log(`results written to ${path.relative(process.cwd(), out)}`);
  }
}

main();
