"use strict";
// Jest test environments for the real-suite benchmark. The harness rewrites a project's jsdom testEnvironment to one of
// the files in envs/, which call makeJestEnvironment() below.
//
// - rsdom: this worktree's src/integrations/jest.js (the code behind @rsdom/jest), with Jest's own packages
//   (jest-util, jest-mock, @jest/fake-timers) resolved from the project under test, as @rsdom/jest does.
// - jsdom30: the same code with jsdom 30.1.2 from npm in place of rsdom (lib/integration.cjs).
// - happy-dom: a CommonJS copy of @happy-dom/jest-environment 20.14.6 (which is ESM-only and resolves Jest's packages
//   from its own location), using the harness's pinned happy-dom.
//
// `fixed` reproduces jest-fixed-jsdom (used by react-hook-form): it puts Node's fetch/streams/encoding globals on the
// window and resolves packages without the "browser" export condition. The swap must keep that, or the comparison
// would measure a different environment.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const { loadIntegration } = require("./integration.cjs");

function projectDir() {
  const dir = process.env.REAL_SUITES_PROJECT_DIR;
  if (!dir) {
    throw new Error("REAL_SUITES_PROJECT_DIR is not set; run the suite through bench/real-suites/run.js");
  }
  return dir;
}

// Jest's packages, resolved where the project's Jest finds them. Under pnpm they are not hoisted to the project root,
// so also look next to the project's jest-environment-jsdom and jest-config (both depend on them).
let jestModules;
function loadJestModules() {
  if (jestModules) {
    return jestModules;
  }
  const root = projectDir();
  const bases = [path.join(root, "package.json")];
  const rootRequire = createRequire(bases[0]);
  for (const anchor of ["jest-environment-jsdom/package.json", "kcd-scripts/package.json", "jest/package.json"]) {
    try {
      const anchorPath = rootRequire.resolve(anchor);
      bases.push(anchorPath);
      const anchorRequire = createRequire(anchorPath);
      for (const inner of ["jest-environment-jsdom/package.json", "jest-config/package.json", "@jest/core/package.json"]) {
        try {
          bases.push(anchorRequire.resolve(inner));
        } catch {
          // not a dependency of this anchor
        }
      }
    } catch {
      // not installed in this project
    }
  }
  const load = name => {
    for (const base of bases) {
      try {
        return createRequire(base)(name);
      } catch (e) {
        if (e.code !== "MODULE_NOT_FOUND") {
          throw e;
        }
      }
    }
    throw new Error(`could not resolve ${name} from ${root}`);
  };
  const { installCommonGlobals } = load("jest-util");
  const { ModuleMocker } = load("jest-mock");
  const { LegacyFakeTimers, ModernFakeTimers } = load("@jest/fake-timers");
  jestModules = { installCommonGlobals, ModuleMocker, LegacyFakeTimers, ModernFakeTimers };
  return jestModules;
}

// Same assignments as jest-fixed-jsdom 0.0.10.
function applyFixedGlobals(global) {
  global.TextDecoder = TextDecoder;
  global.TextEncoder = TextEncoder;
  global.TextDecoderStream = TextDecoderStream;
  global.TextEncoderStream = TextEncoderStream;
  global.ReadableStream = ReadableStream;
  global.Blob = Blob;
  global.Headers = Headers;
  global.FormData = FormData;
  global.Request = Request;
  global.Response = Response;
  global.fetch = fetch;
  global.AbortController = AbortController;
  global.AbortSignal = AbortSignal;
  global.structuredClone = structuredClone;
  global.URL = URL;
  global.URLSearchParams = URLSearchParams;
  global.BroadcastChannel = BroadcastChannel;
  global.TransformStream = TransformStream;
}

// rsdom, or jsdom 30.1.2 run through the same environment code (see integration.cjs).
function integrationEnvironment(impl) {
  const { createEnvironment } = loadIntegration("jest", impl);
  return createEnvironment(loadJestModules);
}

function happyDomEnvironment() {
  // eslint-disable-next-line global-require
  const { Window, BrowserErrorCaptureEnum } = require("happy-dom");
  return class HappyDOMEnvironment {
    fakeTimers = null;

    fakeTimersModern = null;

    customExportConditions = ["node", "node-addons"];

    constructor(config, options) {
      const { installCommonGlobals, ModuleMocker, LegacyFakeTimers, ModernFakeTimers } = loadJestModules();
      const projectConfig = config.projectConfig ?? config;
      const globals = projectConfig.globals;
      this._configuredExportConditions = [];
      if ("customExportConditions" in projectConfig.testEnvironmentOptions) {
        this._configuredExportConditions = projectConfig.testEnvironmentOptions.customExportConditions;
      }
      this.window = new Window({
        url: "http://localhost/",
        ...projectConfig.testEnvironmentOptions,
        console: options?.console || console,
        settings: {
          ...projectConfig.testEnvironmentOptions?.settings,
          errorCapture: BrowserErrorCaptureEnum.disabled
        }
      });
      this.global = this.window;
      this.moduleMocker = new ModuleMocker(this.window);
      this.global.Error.stackTraceLimit = 100;
      this.global.Buffer = Buffer;
      this.window.global = this.global;
      installCommonGlobals(this.window, globals);
      this.global.setImmediate = global.setImmediate;
      this.global.clearImmediate = global.clearImmediate;
      this.fakeTimers = new LegacyFakeTimers({
        config: projectConfig,
        global: this.window,
        moduleMocker: this.moduleMocker,
        timerConfig: { idToRef: id => id, refToId: ref => ref }
      });
      this.fakeTimersModern = new ModernFakeTimers({ config: projectConfig, global: this.window });
      const happyDOMSetTimeout = this.global.setTimeout;
      this.global.setTimeout = (...args) => {
        if (new Error("stack").stack.includes("/jest-jasmine")) {
          return global.setTimeout.call(global, ...args);
        }
        return happyDOMSetTimeout.call(this.global, ...args);
      };
    }

    exportConditions() {
      return this._configuredExportConditions ?? this.customExportConditions;
    }

    async setup() {}

    async teardown() {
      this.fakeTimers.dispose();
      this.fakeTimersModern.dispose();
      await this.global.happyDOM.abort();
      this.global.close();
      this.global = null;
      this.moduleMocker = null;
      this.fakeTimers = null;
      this.fakeTimersModern = null;
    }

    getVmContext() {
      return this.global;
    }
  };
}

// The harness counts environment instances per run (one line per test file) to check the swap took effect.
function markEnvironment(impl) {
  if (process.env.REAL_SUITES_ENV_MARKER) {
    fs.appendFileSync(process.env.REAL_SUITES_ENV_MARKER, `${impl}\n`);
  }
}

function makeJestEnvironment(impl, { fixed = false } = {}) {
  const Base = impl === "happy-dom" ? happyDomEnvironment() : integrationEnvironment(impl);
  return class Environment extends Base {
    constructor(...args) {
      super(...args);
      markEnvironment(impl);
      if (fixed) {
        this.customExportConditions = [""];
        applyFixedGlobals(this.global);
      }
    }
  };
}

module.exports = { makeJestEnvironment };
