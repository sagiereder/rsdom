// Vitest environments for the real-suite benchmark. The harness rewrites a project's DOM environment ("jsdom" or
// "happy-dom") to one of the files in envs/, which call makeVitestEnvironment() below.
//
// - rsdom: this worktree's src/integrations/vitest.js (the code behind @rsdom/vitest and vitest-environment-rsdom),
//   given the project's own vitest/runtime, as those packages do.
// - jsdom30: the same code with jsdom 30.1.2 from npm in place of rsdom (lib/integration.cjs).
// - happy-dom: a copy of Vitest's built-in happy-dom environment (identical in Vitest 4 and 5) that loads the harness's
//   pinned happy-dom rather than whatever the project has installed.
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadIntegration } = require("./integration.cjs");

function projectDir() {
  const dir = process.env.REAL_SUITES_PROJECT_DIR;
  if (!dir) {
    throw new Error("REAL_SUITES_PROJECT_DIR is not set; run the suite through bench/real-suites/run.js");
  }
  return dir;
}

function exportTarget(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    return exportTarget(entry.import) ?? exportTarget(entry.default);
  }
  return undefined;
}

// Imports a subpath export of the project's vitest (e.g. "./runtime") by reading its export map, since the subpath is
// not resolvable from this directory.
async function importProjectVitest(subpath) {
  const pkgPath = createRequire(path.join(projectDir(), "package.json")).resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const target = exportTarget(pkg.exports[subpath]);
  if (!target) {
    throw new Error(`vitest ${pkg.version} has no ${subpath} export`);
  }
  return import(pathToFileURL(path.join(path.dirname(pkgPath), target)).href);
}

async function loadVitestRuntime() {
  try {
    return await importProjectVitest("./runtime");
  } catch {
    return await importProjectVitest("./environments");
  }
}

// rsdom, or jsdom 30.1.2 run through the same environment code (see integration.cjs).
function integrationEnvironment(impl) {
  const { createEnvironment } = loadIntegration("vitest", impl);
  return createEnvironment(loadVitestRuntime);
}

async function teardownWindow(win) {
  if (win.close && win.happyDOM.abort) {
    await win.happyDOM.abort();
    win.close();
  } else {
    win.happyDOM.cancelAsync();
  }
}

function happyDomEnvironment() {
  return {
    name: "happy-dom",
    viteEnvironment: "client",
    async setupVM({ happyDOM = {} }) {
      const { Window } = require("happy-dom");
      let win = new Window({
        ...happyDOM,
        console: console && globalThis.console ? globalThis.console : undefined,
        url: happyDOM.url || "http://localhost:3000",
        settings: { ...happyDOM.settings, disableErrorCapturing: true }
      });
      win.Buffer = Buffer;
      if (typeof structuredClone !== "undefined" && !win.structuredClone) {
        win.structuredClone = structuredClone;
      }
      return {
        getVmContext() {
          return win;
        },
        async teardown() {
          await teardownWindow(win);
          win = undefined;
        }
      };
    },
    async setup(global, { happyDOM = {} }) {
      const { populateGlobal } = await loadVitestRuntime();
      const { Window, GlobalWindow } = require("happy-dom");
      const win = new (GlobalWindow || Window)({
        ...happyDOM,
        console: console && global.console ? global.console : undefined,
        url: happyDOM.url || "http://localhost:3000",
        settings: { ...happyDOM.settings, disableErrorCapturing: true }
      });
      const { keys, originals } = populateGlobal(global, win, {
        bindFunctions: true,
        additionalKeys: [
          "Request", "Response", "MessagePort", "fetch", "Headers", "AbortController", "AbortSignal", "URL",
          "URLSearchParams", "FormData"
        ]
      });
      return {
        async teardown(teardownGlobal) {
          await teardownWindow(win);
          keys.forEach(key => delete teardownGlobal[key]);
          originals.forEach((v, k) => {
            teardownGlobal[k] = v;
          });
        }
      };
    }
  };
}

// The harness counts environment instances per run (one line per test file) to check the swap took effect.
function markEnvironment(impl) {
  if (process.env.REAL_SUITES_ENV_MARKER) {
    appendFileSync(process.env.REAL_SUITES_ENV_MARKER, `${impl}\n`);
  }
}

// Measurement mode (`run.js frames`): records how long each test file's environment existed and for how much of that
// time at least one requestAnimationFrame callback was pending, i.e. code was waiting for the next frame. Wraps the
// global requestAnimationFrame/cancelAnimationFrame without changing when callbacks run.
function recordFrameWaits(global, impl) {
  const file = process.env.REAL_SUITES_FRAME_STATS;
  const raf = global.requestAnimationFrame;
  const caf = global.cancelAnimationFrame;
  if (!file || typeof raf !== "function") {
    return () => {};
  }
  const start = performance.now();
  const pending = new Set();
  let pendingSince = 0;
  let pendingMs = 0;
  let calls = 0;
  const settle = handle => {
    if (pending.delete(handle) && pending.size === 0) {
      pendingMs += performance.now() - pendingSince;
    }
  };
  global.requestAnimationFrame = callback => {
    calls++;
    if (pending.size === 0) {
      pendingSince = performance.now();
    }
    const handle = raf(time => {
      settle(handle);
      return callback(time);
    });
    pending.add(handle);
    return handle;
  };
  global.cancelAnimationFrame = handle => {
    settle(handle);
    return caf(handle);
  };
  return () => {
    if (pending.size > 0) {
      pendingMs += performance.now() - pendingSince;
    }
    const line = { impl, envMs: performance.now() - start, framePendingMs: pendingMs, rafCalls: calls };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  };
}

export function makeVitestEnvironment(impl) {
  const env = impl === "happy-dom" ? happyDomEnvironment() : integrationEnvironment(impl);
  return {
    ...env,
    async setup(global, ...rest) {
      markEnvironment(impl);
      const result = await env.setup(global, ...rest);
      const finish = recordFrameWaits(global, impl);
      return {
        ...result,
        async teardown(...args) {
          finish();
          return result.teardown(...args);
        }
      };
    },
    async setupVM(...args) {
      markEnvironment(impl);
      return env.setupVM(...args);
    }
  };
}
