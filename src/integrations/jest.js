"use strict";
// A Jest test environment backed by rsdom: `testEnvironment: "@rsdom/jest"` (the @rsdom/jest package), or
// `testEnvironment: "@rsdom/core/jest"`.
//
// This mirrors jest-environment-jsdom 30 (@jest/environment-jsdom-abstract) line for line, with rsdom in place of
// jsdom, so `testEnvironmentOptions` (html, url, userAgent, customExportConditions and any JSDOM constructor option)
// behave the same. The Jest packages it needs (jest-util, jest-mock, @jest/fake-timers) are optional peer dependencies:
// they come with Jest. Package managers that don't hoist them (pnpm, Yarn PnP) should use @rsdom/jest,
// which depends on them directly and passes them in through createEnvironment().
const { Buffer: NodeBuffer } = require("node:buffer");
const rsdom = require("../api.js");

function isString(value) {
  return typeof value === "string";
}

function createEnvironment(loadJestModules) {
  let jestModules;
  function jest() {
    jestModules ??= loadJestModules();
    return jestModules;
  }

  return class RsdomEnvironment {
    dom;

    fakeTimers;

    fakeTimersModern;

    global;

    errorEventListener;

    moduleMocker;

    customExportConditions = ["browser"];

    _configuredExportConditions;

    constructor(config, context) {
      const { installCommonGlobals, ModuleMocker, LegacyFakeTimers, ModernFakeTimers } = jest();
      const { projectConfig } = config;
      const { JSDOM, VirtualConsole } = rsdom;

      const virtualConsole = new VirtualConsole();
      virtualConsole.forwardTo(context.console);
      virtualConsole.on("jsdomError", error => {
        context.console.error(error);
      });

      const options = projectConfig.testEnvironmentOptions;
      this.dom = new JSDOM(typeof options.html === "string" ? options.html : "<!DOCTYPE html>", {
        pretendToBeVisual: true,
        // jsdom 28+ (and so rsdom) takes the user agent through the resources option instead of a ResourceLoader.
        resources: typeof options.userAgent === "string" ? { userAgent: options.userAgent } : undefined,
        runScripts: "dangerously",
        url: "http://localhost/",
        virtualConsole,
        ...options
      });
      const global = this.global = this.dom.window;
      if (global === null || global === undefined) {
        throw new Error("rsdom did not return a Window object");
      }

      // For "universal" code; code should use `globalThis`.
      global.global = global;

      // Node's error-message stack size is limited to 10, but it's useful to see more than that when a test fails.
      this.global.Error.stackTraceLimit = 100;
      installCommonGlobals(global, projectConfig.globals);

      // Jest's environments expose Node's Buffer; plenty of test code relies on it.
      global.Buffer = NodeBuffer;

      // Report uncaught errors, unless the test listens for "error" itself (then it presumably handles them).
      let userErrorListenerCount = 0;
      this.errorEventListener = event => {
        if (userErrorListenerCount === 0 && event.error !== null && event.error !== undefined) {
          process.emit("uncaughtException", event.error);
        }
      };
      global.addEventListener("error", this.errorEventListener);

      const originalAddListener = global.addEventListener.bind(global);
      const originalRemoveListener = global.removeEventListener.bind(global);
      global.addEventListener = function (...args) {
        if (args[0] === "error") {
          userErrorListenerCount++;
        }
        return originalAddListener.apply(this, args);
      };
      global.removeEventListener = function (...args) {
        if (args[0] === "error") {
          userErrorListenerCount--;
        }
        return originalRemoveListener.apply(this, args);
      };

      if ("customExportConditions" in options) {
        const { customExportConditions } = options;
        if (Array.isArray(customExportConditions) && customExportConditions.every(isString)) {
          this._configuredExportConditions = customExportConditions;
        } else {
          throw new Error("Custom export conditions specified but they are not an array of strings");
        }
      }

      this.moduleMocker = new ModuleMocker(global);
      this.fakeTimers = new LegacyFakeTimers({
        config: projectConfig,
        global,
        moduleMocker: this.moduleMocker,
        timerConfig: {
          idToRef: id => id,
          refToId: ref => ref
        }
      });
      this.fakeTimersModern = new ModernFakeTimers({ config: projectConfig, global });
    }

    async setup() {}

    async teardown() {
      if (this.fakeTimers) {
        this.fakeTimers.dispose();
      }
      if (this.fakeTimersModern) {
        this.fakeTimersModern.dispose();
      }
      if (this.global) {
        if (this.errorEventListener) {
          this.global.removeEventListener("error", this.errorEventListener);
        }
        this.global.close();
      }
      this.errorEventListener = null;
      this.global = null;
      this.dom = null;
      this.fakeTimers = null;
      this.fakeTimersModern = null;
    }

    exportConditions() {
      return this._configuredExportConditions ?? this.customExportConditions;
    }

    getVmContext() {
      if (this.dom) {
        return this.dom.getInternalVMContext();
      }
      return null;
    }
  };
}

// Resolves Jest's packages from rsdom's own location, where npm and Yarn's node_modules linker hoist them.
const RsdomEnvironment = createEnvironment(() => {
  const { installCommonGlobals } = require("jest-util");
  const { ModuleMocker } = require("jest-mock");
  const { LegacyFakeTimers, ModernFakeTimers } = require("@jest/fake-timers");
  return { installCommonGlobals, ModuleMocker, LegacyFakeTimers, ModernFakeTimers };
});

module.exports = RsdomEnvironment;
module.exports.default = RsdomEnvironment;
module.exports.TestEnvironment = RsdomEnvironment;
module.exports.createEnvironment = createEnvironment;
