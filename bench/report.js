"use strict";
// Regenerates the "Benchmark results" section of the top-level README.md (between the
// <!-- BENCH:START --> and <!-- BENCH:END --> markers) from a bench/run.js results file.
//
//   node bench/report.js                      newest non-baseline results/*.json -> README.md
//   node bench/report.js results/<file>.json  a specific results file
//   --readme <path>   README to update (default: ../README.md)
//   --stdout          print the section instead of writing the README
const fs = require("node:fs");
const path = require("node:path");

const START = "<!-- BENCH:START -->";
const END = "<!-- BENCH:END -->";

// Display areas, in order, and the scenario groups each one covers.
const AREAS = [
  ["Simple divs and lists", ["divs", "lists"]],
  ["Large documents", ["large"]],
  ["Tables", ["tables"]],
  ["Selectors", ["selectors"]],
  ["Events and style", ["events", "style"]],
  ["React", ["react"]],
  ["React (production build)", ["react-prod"]],
  ["Accessibility queries and user-event", ["a11y"]],
  ["Web components", ["webcomponents"]],
  ["Mutation observers", ["mutation"]],
  ["Template rendering", ["template"]],
  ["Forms", ["forms"]],
  ["Window startup", ["startup"]],
  ["Real page parsing", ["parse"]],
  ["XML and SVG", ["xml"]]
];

function parseArgs(argv) {
  const args = { file: null, readme: path.join(__dirname, "..", "README.md"), stdout: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--readme") {
      args.readme = path.resolve(argv[++i]);
    } else if (argv[i] === "--stdout") {
      args.stdout = true;
    } else {
      args.file = path.resolve(argv[i]);
    }
  }
  return args;
}

function newestResults() {
  const dir = path.join(__dirname, "results");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && f !== "baseline.json").sort();
  if (!files.length) {
    throw new Error(`no results in ${dir}; run \`node bench/run.js\` first or pass a file`);
  }
  return path.join(dir, files[files.length - 1]);
}

const fmtMs = ms => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));
const fmtMB = mb => (mb >= 100 ? mb.toFixed(0) : mb >= 10 ? mb.toFixed(1) : mb.toFixed(2));
const fmtX = x => `${x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`;
const geomean = xs => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

function render(results) {
  const stat = results.stat || "median";
  const base = results.baseline || results.impls[0];
  const impl = results.impls.includes("fork") ? "fork" : results.impls.find(i => i !== base);
  // happy-dom gets its own time and speedup columns when the run included it.
  const happy = results.impls.includes("happy-dom") && impl !== "happy-dom" ? "happy-dom" : null;
  const label = { upstream: "jsdom 30.1.2", fork: "rsdom", "fork-js": "rsdom (JSDOM_NATIVE=0)", "happy-dom": "happy-dom" };
  const name = i => label[i] || i;
  const date = results.date.slice(0, 10);
  const { warmup, iters } = results.opts || {};
  const time = (r, i) => {
    const x = r.results[i];
    return x && !x.na && !x.error ? x[stat] : null;
  };

  const lines = [
    `Measured ${date} on ${results.cpu} (${results.platform}), Node.js ${results.node}, rsdom at \`${results.gitRev}\`. ` +
    `Each number is the ${stat} of ${iters} timed iterations after ${warmup} warmups, every scenario in a fresh ` +
    `process; a speedup is the other implementation's time / ${name(impl)} time (> 1 means ${name(impl)} is faster).`,
    ""
  ];
  const cols = ["Area", "Scenario", `${name(base)} (ms)`];
  if (happy) {
    cols.push(`${name(happy)} (ms)`);
  }
  cols.push(`${name(impl)} (ms)`, `vs ${name(base)}`);
  if (happy) {
    cols.push(`vs ${name(happy)}`);
  }
  lines.push(`| ${cols.join(" | ")} |`, `|---|---|${"--:|".repeat(cols.length - 2)}`);

  const vsBase = [];
  const vsHappy = [];
  const row = (areaCell, r) => {
    const a = time(r, base);
    const b = time(r, impl);
    const h = happy ? time(r, happy) : null;
    const cells = [areaCell, `\`${r.scenario}\``, a === null ? "N/A" : fmtMs(a)];
    if (happy) {
      cells.push(h === null ? "N/A" : fmtMs(h));
    }
    cells.push(b === null ? "N/A" : fmtMs(b));
    if (a !== null && b !== null) {
      vsBase.push(a / b);
      cells.push(fmtX(a / b));
    } else {
      cells.push("N/A");
    }
    if (happy) {
      if (h !== null && b !== null) {
        vsHappy.push(h / b);
        cells.push(fmtX(h / b));
      } else {
        cells.push("N/A");
      }
    }
    lines.push(`| ${cells.join(" | ")} |`);
  };
  for (const [area, groups] of AREAS) {
    results.rows.filter(r => groups.includes(r.group)).forEach((r, i) => row(i === 0 ? `**${area}**` : "", r));
  }
  for (const r of results.rows.filter(r => !AREAS.some(([, g]) => g.includes(r.group)))) {
    row(r.group, r);
  }
  const mean = ["", "**Geometric mean**", ...Array(cols.length - (happy ? 4 : 3)).fill(""), `**${fmtX(geomean(vsBase))}**`];
  if (happy) {
    mean.push(`**${fmtX(geomean(vsHappy))}**`);
  }
  lines.push(`| ${mean.join(" | ")} |`);
  lines.push(...renderMemory(results, { base, impl, happy, name }));
  lines.push("", "Regenerate this table with `node bench/report.js` after a full `node bench/run.js`.");
  return lines.join("\n");
}

// Retained heap (JS heap + external still reachable after run, over the worker's post-load baseline; median over the
// timed iterations) and the worker process's peak RSS, per scenario. Ratios are other / rsdom (> 1 means rsdom uses
// less). The retained-heap geomean skips scenarios where either side keeps < 1 MB, where the ratio is noise.
function renderMemory(results, { base, impl, happy, name }) {
  const has = results.rows.some(r => r.results[impl] && r.results[impl].retainedMB !== undefined);
  if (!has) {
    return [];
  }
  const mem = (r, i, key) => {
    const x = r.results[i];
    return x && !x.na && !x.error && x[key] !== undefined ? x[key] : null;
  };
  const others = happy ? [base, happy] : [base];
  const shown = [base, ...(happy ? [happy] : []), impl];
  const lines = [
    "",
    "### Memory",
    "",
    "**Retained heap** is the JS heap plus external memory still reachable after the scenario ran (the document is " +
    "still held, as a test would hold it), over a baseline taken after the implementation was loaded; it is read after " +
    "a full GC, as the median over the timed iterations. **Peak RSS** is the worker process's maximum resident set size " +
    "over the whole run, including module loading and warmups, so it also reflects garbage the GC had not yet " +
    "reclaimed. Lower is better; ratios are the other implementation's number / rsdom's.",
    ""
  ];
  const cols = ["Area", "Scenario", ...shown.map(i => `${name(i)} retained (MB)`), ...shown.map(i => `${name(i)} peak RSS (MB)`)];
  lines.push(`| ${cols.join(" | ")} |`, `|---|---|${"--:|".repeat(cols.length - 2)}`);
  const ratios = { retained: new Map(others.map(o => [o, []])), rss: new Map(others.map(o => [o, []])) };
  const row = (areaCell, r) => {
    const cells = [areaCell, `\`${r.scenario}\``];
    for (const i of shown) {
      const v = mem(r, i, "retainedMB");
      cells.push(v === null ? "N/A" : fmtMB(v));
    }
    for (const i of shown) {
      const v = mem(r, i, "peakRssMB");
      cells.push(v === null ? "N/A" : String(v));
    }
    const mine = mem(r, impl, "retainedMB");
    const myRss = mem(r, impl, "peakRssMB");
    for (const o of others) {
      const v = mem(r, o, "retainedMB");
      if (v !== null && mine !== null && v >= 1 && mine >= 1) {
        ratios.retained.get(o).push(v / mine);
      }
      const rss = mem(r, o, "peakRssMB");
      if (rss !== null && myRss !== null) {
        ratios.rss.get(o).push(rss / myRss);
      }
    }
    lines.push(`| ${cells.join(" | ")} |`);
  };
  for (const [area, groups] of AREAS) {
    results.rows.filter(r => groups.includes(r.group)).forEach((r, i) => row(i === 0 ? `**${area}**` : "", r));
  }
  for (const r of results.rows.filter(r => !AREAS.some(([, g]) => g.includes(r.group)))) {
    row(r.group, r);
  }
  const summary = others.map(o => {
    const ret = ratios.retained.get(o);
    const rss = ratios.rss.get(o);
    return `${name(o)} retains **${fmtX(geomean(ret))}** as much heap as ${name(impl)} (geometric mean over the ` +
      `${ret.length} scenarios where both keep at least 1 MB) and peaks at **${fmtX(geomean(rss))}** its RSS`;
  });
  lines.push("", `${summary.join("; ")}.`);
  return lines;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file || newestResults();
  const section = render(JSON.parse(fs.readFileSync(file, "utf8")));
  if (args.stdout) {
    process.stdout.write(`${section}\n`);
    return;
  }
  const readme = fs.readFileSync(args.readme, "utf8");
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`${args.readme} has no ${START} ... ${END} section`);
  }
  fs.writeFileSync(args.readme, `${readme.slice(0, s + START.length)}\n${section}\n${readme.slice(e)}`);
  console.log(`updated ${path.relative(process.cwd(), args.readme)} from ${path.relative(process.cwd(), file)}`);
}

main();
