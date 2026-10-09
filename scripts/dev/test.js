"use strict";
/* eslint-disable func-style, @stylistic/max-len */
/* eslint-disable no-console */
// Fast developer test runner.
//
//   node scripts/dev/test.js                 run tests relevant to files changed vs. the `rust` branch base
//   node scripts/dev/test.js --all           run the whole suite (api, to-port-to-wpts, WPT, to-upstream WPT), sharded
//   node scripts/dev/test.js --wpt dom/nodes,html/syntax   run specific WPT dirs (prefix match, files allowed)
//   node scripts/dev/test.js --api           run only the mocha API tests
//   options: -j <n> parallel workers (default: CPU count), --base <ref> diff base, --verbose
//
// Needs the shared WPT servers (.devshim/wpt-servers.sh); it starts them if they are not running.
const { spawn, execSync, execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "../..");
const wptDir = path.join(root, "test/web-platform-tests");
const argv = process.argv.slice(2);
const opt = name => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const flag = name => argv.includes(name);
const jobs = Number(opt("-j")) || os.cpus().length;
const verbose = flag("--verbose");

// Changed path (regex) -> WPT dirs (prefix match against to-run.yaml DIRs) and whether API tests should run.
const RELEVANCE = [
  [
    /^native\/src\/(html|parse|tokeni|tree_builder)/, [
      "html/syntax", "domparsing", "html/semantics/scripting-1",
      "html/webappapis/dynamic-markup-insertion", "dom/nodes", "custom-elements", "shadow-dom"
    ]
  ],
  [/^native\/src\/(css|style|cascade)/, ["css", "html/rendering", "dom/nodes/Element-matches", "html/semantics/selectors"]],
  [/^native\/src\/(select|query)/, ["css/selectors", "dom/nodes", "html/semantics/selectors", "shadow-dom"]],
  [/^native\/src\/(serial)/, ["domparsing", "html/syntax", "dom/nodes", "html/semantics/scripting-1/the-template-element"]],
  [/^native\//, ["dom/nodes", "domparsing", "html/syntax", "html/dom", "css/selectors"]],
  [
    /^lib\/jsdom\/browser\/parser\//, [
      "html/syntax", "domparsing", "html/semantics/scripting-1", "dom/nodes",
      "html/webappapis/dynamic-markup-insertion", "custom-elements", "shadow-dom", "html/semantics/forms"
    ]
  ],
  [/^lib\/jsdom\/living\/domparsing\//, ["domparsing", "html/syntax", "dom/nodes", "shadow-dom"]],
  [
    /^lib\/jsdom\/living\/css\//, [
      "css", "html/rendering", "html/semantics/document-metadata/the-style-element",
      "html/semantics/document-metadata/the-link-element"
    ]
  ],
  [/^lib\/jsdom\/living\/helpers\/style-rules/, ["css", "html/rendering"]],
  [
    /^lib\/jsdom\/living\/helpers\/(selectors|dom-tree|node|create-element|internal-constants)/, [
      "dom", "css/selectors",
      "html/semantics/selectors", "shadow-dom", "custom-elements", "domparsing", "html/dom"
    ]
  ],
  [
    /^lib\/jsdom\/living\/(nodes|attributes|helpers)\//, [
      "dom", "html/dom", "shadow-dom", "custom-elements",
      "domparsing", "html/semantics", "html/syntax", "css/selectors", "css/cssom"
    ]
  ],
  [/^lib\/jsdom\/living\/events\//, ["dom/events", "html/webappapis", "uievents", "pointerevents", "shadow-dom"]],
  [/^lib\/jsdom\/living\/range\//, ["dom/ranges", "selection"]],
  [/^lib\/jsdom\/living\/traversal\//, ["dom/traversal"]],
  [/^lib\/jsdom\/living\/mutation-observer\//, ["dom/nodes", "custom-elements"]],
  [/^lib\/jsdom\/living\/custom-elements\//, ["custom-elements"]],
  [/^lib\/jsdom\/living\/xhr\//, ["xhr"]],
  [/^lib\/jsdom\/living\/(window|navigator)\//, ["html/browsers", "html/webappapis"]],
  [/^lib\/jsdom\/browser\//, ["html/browsers", "html/webappapis", "dom/nodes"]],
  [/^lib\//, ["dom/nodes", "html/dom", "domparsing", "html/syntax"]],
  [/^test\/web-platform-tests\/to-run\.yaml$/, ["*"]]
];

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function changedFiles(base) {
  const mergeBase = sh(`git merge-base HEAD ${base}`);
  const committed = sh(`git diff --name-only ${mergeBase}`).split("\n");
  const untracked = sh("git ls-files --others --exclude-standard").split("\n");
  return [...new Set([...committed, ...untracked])].filter(Boolean);
}

function allWptDirs() {
  const yaml = require("js-yaml");
  const { readManifest, getPossibleTestFilePaths } = require(path.join(wptDir, "wpt-manifest-utils.js"));
  const files = getPossibleTestFilePaths(readManifest(path.join(wptDir, "wpt-manifest.json")));
  const docs = yaml.loadAll(fs.readFileSync(path.join(wptDir, "to-run.yaml"), "utf8"));
  return docs.filter(d => d && d.DIR).map(d => ({
    dir: d.DIR,
    weight: files.filter(f => f.startsWith(d.DIR + "/")).length
  }));
}

function selectDirs(prefixes, dirs) {
  if (prefixes.includes("*")) {
    return dirs;
  }
  return dirs.filter(d => prefixes.some(p => d.dir === p || d.dir.startsWith(p + "/") || p.startsWith(d.dir + "/")));
}

// Greedy bin-packing of WPT dirs into `n` shards by test-file count.
function shard(dirs, n) {
  const bins = Array.from({ length: n }, () => ({ weight: 0, dirs: [] }));
  for (const d of [...dirs].sort((a, b) => b.weight - a.weight)) {
    const bin = bins.reduce((a, b) => a.weight <= b.weight ? a : b);
    bin.weight += d.weight;
    bin.dirs.push(d.dir);
  }
  return bins.filter(b => b.dirs.length);
}

async function ensureServers() {
  const up = port => {
    try {
      execFileSync("curl", ["-s", "-o", "/dev/null", "--max-time", "2", `http://127.0.0.1:${port}/`]);
      return true;
    } catch {
      return false;
    }
  };
  if (up(9000) && up(10000)) {
    return;
  }
  console.log("Starting shared WPT servers...");
  execFileSync(path.join(root, ".devshim/wpt-servers.sh"), { stdio: "inherit" });
}

function runMocha(label, args, extraEnv = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    const child = spawn(process.execPath, [path.join(root, "node_modules/mocha/bin/mocha.js"), "--reporter", "dot", "--exit", ...args], {
      cwd: root,
      env: { ...process.env, JSDOM_WPT_EXTERNAL: "1", FORCE_COLOR: "0", ...extraEnv }
    });
    let out = "";
    // A job that produces no output for this long is considered hung (e.g. a WPT server problem).
    const idleLimit = Number(process.env.JSDOM_TEST_IDLE_MS) || 5 * 60_000;
    let idleTimer;
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        out += `\n[dev/test.js] killed: no output for ${idleLimit / 1000}s (hung)\n`;
        child.kill("SIGKILL");
      }, idleLimit);
    };
    bump();
    child.stdout.on("data", bump);
    child.stderr.on("data", bump);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (out += d));
    child.on("close", code => {
      clearTimeout(idleTimer);
      const num = re => Number((out.match(re) || [])[1] || 0);
      const result = {
        label, code, out, ms: Date.now() - start,
        passing: num(/(\d+) passing/), failing: num(/(\d+) failing/), pending: num(/(\d+) pending/)
      };
      const status = code === 0 ? "ok  " : "FAIL";
      console.log(`${status} ${label.padEnd(60).slice(0, 60)} ${String(result.passing).padStart(5)} pass ` +
        `${String(result.failing).padStart(4)} fail  ${(result.ms / 1000).toFixed(1)}s`);
      result.rerun = () => runMocha(`${label} (retry)`, args, extraEnv);
      resolve(result);
    });
  });
}

async function pool(tasks, n) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      results.push(await t());
    }
  }));
  return results;
}

const API_TASKS = [
  ["api", ["test/api/"]],
  ["to-port-to-wpts", ["test/to-port-to-wpts/"]],
  ["to-port-to-wpts/level1", ["test/to-port-to-wpts/level1/"]],
  ["to-port-to-wpts/level2", ["test/to-port-to-wpts/level2/"]],
  ["to-port-to-wpts/level3", ["test/to-port-to-wpts/level3/"]]
];

async function main() {
  const t0 = Date.now();
  const dirs = allWptDirs();
  let wptPrefixes = [];
  let runApi = false;
  let runTuwpt = false;

  if (flag("--all")) {
    wptPrefixes = ["*"];
    runApi = true;
    runTuwpt = true;
  } else if (opt("--wpt")) {
    wptPrefixes = opt("--wpt").split(",");
  } else if (flag("--api")) {
    runApi = true;
  } else {
    const files = changedFiles(opt("--base") || "rust");
    for (const f of files) {
      for (const [re, prefixes] of RELEVANCE) {
        if (re.test(f)) {
          wptPrefixes.push(...prefixes);
          break;
        }
      }
      if (/^(lib|native)\//.test(f) || /^test\/(api|to-port)/.test(f)) {
        runApi = true;
      }
      if (/^test\/web-platform-tests\/to-upstream/.test(f) || /^lib\//.test(f)) {
        runTuwpt = true;
      }
    }
    wptPrefixes = [...new Set(wptPrefixes)];
    console.log(`Changed files: ${files.length}; relevant WPT dirs: ${wptPrefixes.join(", ") || "(none)"}`);
  }

  const selected = wptPrefixes.length ? selectDirs(wptPrefixes, dirs) : [];
  // A prefix deeper than a to-run.yaml DIR (e.g. a single test file) narrows that DIR within its shard.
  const narrow = d => {
    const deeper = wptPrefixes.filter(p => p.startsWith(d + "/"));
    return deeper.length ? deeper : [d];
  };
  const tasks = [];
  if (runApi) {
    for (const [label, args] of API_TASKS) {
      tasks.push(() => runMocha(label, args));
    }
  }
  if (runTuwpt) {
    tasks.push(() => runMocha("to-upstream WPT", ["test/web-platform-tests/run-tuwpts.js"]));
  }
  if (selected.length) {
    await ensureServers();
    const shardCount = Math.max(1, Math.min(jobs * 2, selected.length));
    for (const bin of shard(selected, shardCount)) {
      const envDirs = bin.dirs.flatMap(narrow).join(",");
      tasks.push(() => runMocha(`wpt: ${envDirs}`, [path.join(__dirname, "run-wpt-shard.js")], { WPT_DIRS: envDirs }));
    }
  }
  if (runTuwpt && !selected.length) {
    await ensureServers();
  }

  const results = await pool(tasks, jobs);
  // Failures under heavy parallel load are often timeouts; re-run failed jobs one at a time to
  // separate real failures from load flakes (disable with --no-retry).
  if (!flag("--no-retry")) {
    const toRetry = results.filter(r => r.code !== 0);
    if (toRetry.length) {
      console.log(`\nRetrying ${toRetry.length} failed job(s) serially...`);
    }
    for (const r of toRetry) {
      const again = await r.rerun();
      results[results.indexOf(r)] = again.code === 0 ? { ...again, flaky: true } : again;
    }
  }
  const flaky = results.filter(r => r.flaky).map(r => r.label);
  if (flaky.length) {
    console.log(`Flaky (failed in parallel, passed on retry): ${flaky.join("; ")}`);
  }
  const failed = results.filter(r => r.code !== 0);
  const total = results.reduce((a, r) => ({ p: a.p + r.passing, f: a.f + r.failing, s: a.s + r.pending }), { p: 0, f: 0, s: 0 });
  for (const r of failed) {
    console.log(`\n===== ${r.label} (exit ${r.code}) =====`);
    const idx = r.out.search(/\d+ failing/);
    console.log(verbose || idx === -1 ? r.out.slice(-8000) : r.out.slice(idx, idx + 20000));
  }
  console.log(`\nTOTAL: ${total.p} passing, ${total.f} failing, ${total.s} pending in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    ` (${failed.length} of ${results.length} jobs failed)`);
  fs.writeFileSync(
    path.join(os.tmpdir(), "jsdom-dev-test-last.json"),
    JSON.stringify({ total, failed: failed.map(r => r.label) }, null, 2)
  );
  process.exitCode = failed.length ? 1 : 0;
}

main();
