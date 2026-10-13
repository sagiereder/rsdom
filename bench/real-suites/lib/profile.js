"use strict";
// Breaks down .cpuprofile files from a test run (the runner's main process and every worker) into where the CPU time
// went: the DOM implementation (by area), React, Testing Library, the project and its other libraries, the test runner,
// transform/compile, Node core, and GC.
//
// Each sample's self time is attributed to a category from its frame's script URL. Frames without a URL (V8 builtins,
// native addon calls, accessors) take the category of their nearest caller with one, so e.g. time inside a native
// rsdom call or Array.prototype.sort called from React counts for rsdom or React respectively.
//
// Time inside the DOM implementation is further split by *area*, decided by the outermost DOM frame on the stack, i.e.
// the DOM API that library or test code called (querySelectorAll -> selectors, dispatchEvent -> events, ...). So an
// area includes everything the DOM does on behalf of that call.
const fs = require("node:fs");
const path = require("node:path");

const DOM_DEPS = [
  "@asamuzakjp", "nwsapi", "cssstyle", "css-tree", "parse5", "whatwg-url", "webidl-conversions", "tough-cookie",
  "decimal.js", "saxes", "w3c-xmlserializer", "@bramus", "rrweb-cssom", "data-urls", "whatwg-mimetype",
  "whatwg-encoding", "html-encoding-sniffer", "@exodus", "symbol-tree", "domexception", "abab", "form-data",
  "xml-name-validator", "is-potential-custom-element-name", "tr46", "punycode", "lru-cache", "@csstools",
  "mdn-data", "entities", "http-proxy-agent", "https-proxy-agent", "undici", "cssom", "acorn-globals", "escodegen",
  "nwmatcher", "whatwg-fetch", "agent-base", "iconv-lite", "happy-dom", "webidl-conversions", "css.escape",
  "@types", "rrweb", "jsdom", "jest-environment-jsdom", "jest-fixed-jsdom", "@jest/environment-jsdom-abstract"
];
const REACT = ["react", "react-dom", "scheduler", "react-is", "use-sync-external-store", "react-test-renderer"];
const TESTING_LIBRARY = ["@testing-library", "dom-accessibility-api", "aria-query", "lz-string", "pretty-format",
  "@adobe", "jest-axe", "axe-core", "vitest-axe"];
const RUNNER = ["jest", "@jest", "jest-circus", "jest-runtime", "jest-runner", "jest-worker", "jest-util",
  "jest-mock", "jest-snapshot", "jest-message-util", "jest-matcher-utils", "jest-diff", "jest-each",
  "jest-resolve", "jest-haste-map", "jest-config", "jest-watcher", "jest-regex-util", "jest-validate",
  "jest-environment-node", "jest-leak-detector", "jest-cli", "expect", "@vitest", "vitest", "tinypool", "tinyspy",
  "tinyrainbow", "chai", "loupe", "stack-utils", "source-map-support", "graceful-fs", "micromatch", "picomatch",
  "fast-glob", "glob", "@sinonjs", "ci-info", "chalk", "jest-pnp-resolver", "exit", "emittery", "p-limit",
  "vite-node", "@vitest/runner", "strip-ansi", "ansi-styles", "jest-changed-files", "jest-fail-on-console",
  "vitest-fail-on-console", "magic-string", "jest-in-case", "obug", "debug", "tinyglobby", "fdir", "tinyexec",
  "std-env", "pathe", "es-module-lexer", "jest-environment-jsdom-global"];
const TRANSFORM = ["@swc", "@babel", "babel-jest", "babel-plugin-istanbul", "babel-preset-jest", "esbuild",
  "@esbuild", "esbuild-jest", "@jest/transform", "vite", "rollup", "@rollup", "rolldown", "@rolldown", "@oxc-project",
  "oxc-transform", "oxc-parser", "typescript", "@jridgewell", "source-map", "convert-source-map", "@vitejs",
  "sucrase", "babel-preset-current-node-syntax", "write-file-atomic", "postcss", "lightningcss",
  "vite-plugin-solid", "babel-preset-solid", "rolldown-plugin-react-forward-ref", "@ampproject", "kcd-scripts",
  "babel-plugin-macros", "babel-preset-react-app", "regenerator-runtime", "core-js", "@napi-rs", "oxc-resolver",
  "lodash", "json5", "browserslist", "caniuse-lite", "semver", "resolve"];
const COMPILE_FUNCTIONS = new Set(["compileFunction", "createScriptFromCode", "wrapCodeInModuleWrapper",
  "transformSource", "_transformAndBuildScript", "transform", "transformFile", "transformRequest", "Script",
  "loadAndTransform", "fetchModule", "ssrTransform", "compileSourceTextModule", "SourceTextModule",
  "runInThisContext", "wrapSafe"]);

function packageOf(url) {
  const i = url.lastIndexOf("node_modules/");
  if (i === -1) {
    return null;
  }
  const rest = url.slice(i + "node_modules/".length).split("/");
  return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
}

function inList(pkg, list) {
  return list.includes(pkg) || list.includes(pkg.split("/")[0]);
}

function makeClassifier({ projectDir, repoRoot }) {
  const rsdomSrc = path.join(repoRoot, "src") + path.sep;
  // The harness's environment code and its own node_modules (happy-dom, jsdom 30.1.2). The project clones live in
  // the harness's .cache/, so they must not match this.
  const harness = new RegExp(`^${path.join(repoRoot, "bench/real-suites")}/(lib|envs|node_modules)/`);
  return function classify(url) {
    if (!url) {
      return null;
    }
    let file = url.startsWith("file://") ? decodeURIComponent(url.slice(7)) : url;
    file = file.replace(/\?.*$/, "");
    if (file.startsWith("node:") || !file.startsWith("/")) {
      return file.startsWith("node:") ? "node core" : "other";
    }
    const pkg = packageOf(file);
    if (file.startsWith(rsdomSrc) || harness.test(file) || pkg === "happy-dom") {
      return "DOM";
    }
    if (pkg) {
      if (inList(pkg, DOM_DEPS)) {
        return "DOM";
      }
      if (inList(pkg, REACT)) {
        return "React";
      }
      if (inList(pkg, TESTING_LIBRARY) || pkg === "@testing-library/user-event") {
        return "Testing Library";
      }
      if (inList(pkg, TRANSFORM)) {
        return "transform/compile";
      }
      if (inList(pkg, RUNNER) || pkg.startsWith("jest-") || pkg.startsWith("@vitest/")) {
        return "test runner";
      }
      return "project code + other libraries";
    }
    if (file.startsWith(projectDir)) {
      return "project code + other libraries";
    }
    return "other";
  };
}

// Area of a DOM call, from the outermost DOM frame (the API the caller invoked) and, failing that, the innermost one.
function domArea(frames) {
  const text = frames.map(f => `${f.functionName} ${f.url}`).join("\n");
  const outer = frames[0];
  const o = `${outer.functionName} ${outer.url}`;
  const tests = [
    ["window setup/teardown", /\bJSDOM\b|Window\.js|installInterfaces|setupWindow|api\.js|jest\.js|vitest\.js|lib\/jest-env|lib\/vitest-env|populateGlobal|\bclose\b|_globalProxy|installCommonGlobals|BrowserWindow|GlobalWindow|happyDOM|interfaces\.js|createWindow/],
    ["parsing/serialization", /innerHTML|outerHTML|insertAdjacentHTML|parse5|htmltodom|parseFragment|DOMParser|serializ|parseHTML|HTMLParser|XMLParser|createContextualFragment|domparsing/i],
    ["selectors", /querySelector|matches|closest|getElementsBy|getElementById|dom-selector|nwsapi|nwmatcher|SelectorParser|QuerySelector|SelectorItem/],
    ["style/getComputedStyle", /getComputedStyle|CSSStyleDeclaration|CSSStyleProperties|cssstyle|css-tree|style-rules|StyleSheet|CSSRule|\bstyle\b|setProperty|getPropertyValue|css-color|cssom|CSSOM|@csstools|computed|cascade/i],
    ["events", /dispatchEvent|EventTarget|addEventListener|removeEventListener|Event-impl|Event\.js|\bclick\b|\bfocus\b|\bblur\b|invokeEventListeners|_dispatch|fireAnEvent|focusing|UIEvent|MouseEvent|KeyboardEvent|PointerEvent|InputEvent|FocusEvent|EventDispatcher/],
    ["mutation observers", /MutationObserver|mutation-observers|queueMutationRecord|notifyMutationObservers/],
    ["timers/microtasks", /setTimeout|setInterval|requestAnimationFrame|timerInitializationSteps|queueMicrotask|Timer/],
    ["DOM tree ops", /appendChild|insertBefore|removeChild|replaceChild|createElement|createTextNode|setAttribute|removeAttribute|getAttribute|textContent|cloneNode|_insert|_remove|_append|Node-impl|Element-impl|Node\.js|Element\.js|Attr|DocumentFragment|\bappend\b|\bremove\b|\bprepend\b|nodeValue|classList|DOMTokenList|dataset|focus/],
    ["accessibility/layout props", /getBoundingClientRect|offset|client|scroll|hidden|checkVisibility|ariaLabel|labels|validity|value|checked|selected/i]
  ];
  for (const [area, re] of tests) {
    if (re.test(o)) {
      return area;
    }
  }
  for (const [area, re] of tests) {
    if (re.test(text)) {
      return area;
    }
  }
  return "other DOM";
}

function analyzeProfiles(dir, opts) {
  const classify = makeClassifier(opts);
  const totals = new Map();
  const areas = new Map();
  const domFns = new Map();
  // Top self-time functions per category, and who called into Node core (the nearest caller outside it).
  const fnsByCat = new Map();
  const nodeCoreBy = new Map();
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".cpuprofile"));
  let totalMs = 0, idleMs = 0;
  const processes = [];
  for (const f of files) {
    const prof = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const byId = new Map(prof.nodes.map(n => [n.id, n]));
    const parent = new Map();
    for (const n of prof.nodes) {
      for (const c of n.children ?? []) {
        parent.set(c, n.id);
      }
    }
    const selfMs = new Map();
    for (let i = 0; i < prof.samples.length; i++) {
      const dt = (prof.timeDeltas[i + 1] ?? 0) / 1000;
      selfMs.set(prof.samples[i], (selfMs.get(prof.samples[i]) ?? 0) + dt);
    }
    const catMemo = new Map();
    const internalCompile = new Set();
    const catOf = id => {
      if (catMemo.has(id)) {
        return catMemo.get(id);
      }
      const n = byId.get(id);
      const { functionName, url } = n.callFrame;
      let c;
      if (functionName === "(garbage collector)") {
        c = "GC";
      } else if (functionName === "(idle)") {
        c = "idle";
      } else if (functionName === "(program)") {
        c = "V8/native (unattributed)";
      } else if (functionName === "(root)") {
        c = "other";
      } else if (COMPILE_FUNCTIONS.has(functionName) && (!url || url.startsWith("node:"))) {
        // V8 compiling a module's source (Jest's vm Script, Vitest's module runner, Node's own loaders).
        c = "transform/compile";
        internalCompile.add(id);
      } else {
        c = classify(url);
        if (c === null) {
          const p = parent.get(id);
          c = p === undefined ? "other" : catOf(p);
          if (c === "idle" || c === "GC") {
            c = "other";
          }
        }
      }
      catMemo.set(id, c);
      return c;
    };
    let procTotal = 0;
    for (const [id, ms] of selfMs) {
      let c = catOf(id);
      if (c === "idle") {
        idleMs += ms;
        continue;
      }
      procTotal += ms;
      // Node core work (module resolution, file reads) and V8 compilation done on behalf of the nearest caller outside
      // Node core: when that caller is the DOM implementation, it is the DOM loading its own code.
      if (c === "node core" || internalCompile.has(id)) {
        let cur = parent.get(id);
        while (cur !== undefined && (["node core", "other"].includes(catOf(cur)) || internalCompile.has(cur))) {
          cur = parent.get(cur);
        }
        const by = cur === undefined ? "(no caller outside Node core)" : catOf(cur);
        if (c === "node core") {
          nodeCoreBy.set(by, (nodeCoreBy.get(by) ?? 0) + ms);
        }
        if (by === "DOM") {
          c = "DOM: loading its own modules (fs + compile)";
        }
      }
      totals.set(c, (totals.get(c) ?? 0) + ms);
      {
        const { functionName, url, lineNumber } = byId.get(id).callFrame;
        const label = `${functionName || "(anonymous)"} ${shortUrl(url)}:${lineNumber + 1}`;
        const m = fnsByCat.get(c) ?? new Map();
        m.set(label, (m.get(label) ?? 0) + ms);
        fnsByCat.set(c, m);
      }
      if (c === "DOM") {
        // Collect the run of DOM frames ending at this node, outermost first.
        const frames = [];
        let cur = id;
        while (cur !== undefined && catOf(cur) === "DOM") {
          const { functionName, url, lineNumber } = byId.get(cur).callFrame;
          if (url) {
            frames.unshift({ functionName, url, lineNumber });
          }
          cur = parent.get(cur);
        }
        const area = frames.length ? domArea(frames) : "other DOM";
        areas.set(area, (areas.get(area) ?? 0) + ms);
        const self = byId.get(id).callFrame;
        const label = `${self.functionName || "(anonymous)"} ${shortUrl(self.url || frames.at(-1)?.url || "")}:${self.lineNumber + 1}`;
        domFns.set(label, (domFns.get(label) ?? 0) + ms);
      }
    }
    totalMs += procTotal;
    processes.push({ file: f, cpuMs: Math.round(procTotal) });
  }
  const sorted = m => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, ms: Math.round(v),
    pct: Math.round(1000 * v / totalMs) / 10 }));
  return {
    profiles: files.length,
    cpuMs: Math.round(totalMs),
    idleMs: Math.round(idleMs),
    categories: sorted(totals),
    domAreas: sorted(areas),
    topDomFunctions: sorted(domFns).slice(0, 30),
    nodeCoreByCaller: sorted(nodeCoreBy),
    topFunctionsByCategory: Object.fromEntries([...fnsByCat].map(([c, m]) => [c, sorted(m).slice(0, 12)])),
    processes: processes.sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 12)
  };
}

function shortUrl(url) {
  return url.replace(/^file:\/\//, "").replace(/.*\/node_modules\//, "").replace(/.*\/src\/jsdom\//, "rsdom:")
    .replace(/.*\/src\//, "rsdom:src/");
}

function formatBreakdown(b) {
  const lines = [`  ${b.profiles} processes, ${(b.cpuMs / 1000).toFixed(1)}s CPU (excluding idle)`];
  lines.push("  by category:");
  for (const c of b.categories) {
    lines.push(`    ${(c.ms / 1000).toFixed(2).padStart(7)}s ${String(c.pct).padStart(5)}%  ${c.name}`);
  }
  lines.push("  Node core time by nearest caller outside Node core (% of all CPU):");
  for (const c of b.nodeCoreByCaller) {
    lines.push(`    ${(c.ms / 1000).toFixed(2).padStart(7)}s ${String(c.pct).padStart(5)}%  ${c.name}`);
  }
  lines.push("  top Node core functions (self time):");
  for (const c of (b.topFunctionsByCategory["node core"] ?? []).slice(0, 8)) {
    lines.push(`    ${(c.ms / 1000).toFixed(2).padStart(7)}s ${String(c.pct).padStart(5)}%  ${c.name}`);
  }
  lines.push("  DOM by area (% of all CPU):");
  for (const c of b.domAreas) {
    lines.push(`    ${(c.ms / 1000).toFixed(2).padStart(7)}s ${String(c.pct).padStart(5)}%  ${c.name}`);
  }
  lines.push("  top DOM functions (self time):");
  for (const c of b.topDomFunctions.slice(0, 20)) {
    lines.push(`    ${(c.ms / 1000).toFixed(2).padStart(7)}s ${String(c.pct).padStart(5)}%  ${c.name}`);
  }
  return lines.join("\n");
}

module.exports = { analyzeProfiles, formatBreakdown };
