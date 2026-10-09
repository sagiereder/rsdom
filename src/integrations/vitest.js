"use strict";
// A Vitest environment backed by rsdom: `environment: "rsdom"` (through the vitest-environment-rsdom package), or
// a path to this file, e.g. `environment: "./node_modules/rsdom/src/integrations/vitest.js"`.
//
// This mirrors Vitest's built-in jsdom environment (vitest/src/integrations/env/jsdom.ts) with rsdom in place of
// jsdom. Options are read from `environmentOptions.rsdom`, falling back to `environmentOptions.jsdom` so a project can
// switch environments without moving its options.
const { Buffer: NodeBuffer } = require("node:buffer");
const { URL: NodeURL } = require("node:url");
const rsdom = require("../api.js");
const { implForWrapper } = require("../generated/idl/utils.js");

let NodeFormData, NodeBlob, NodeRequest;

// setupVM() (Vitest's vmThreads/vmForks pools): Node globals the window lacks, and Node globals that replace its own.
const WINDOW_FILL_INS = [
  "structuredClone", "BroadcastChannel", "MessageChannel",
  "MessagePort", "TextEncoder", "TextDecoder"
];
const NODE_OVERRIDES = ["fetch", "Response", "Headers", "AbortController", "AbortSignal", "URLSearchParams"];

function vitestMajor() {
  try {
    return Number(require("vitest/package.json").version.split(".")[0]);
  } catch {
    return Infinity;
  }
}

// vitest/runtime (Vitest 4+) replaced vitest/environments (Vitest <= 4).
async function importVitestRuntime() {
  try {
    return await import("vitest/runtime");
  } catch {
    return await import("vitest/environments");
  }
}

function createDOM(options = {}) {
  // Capture Node's versions before anything can overwrite the globals.
  NodeFormData = globalThis.FormData;
  NodeBlob = globalThis.Blob;
  NodeRequest = globalThis.Request;

  const { CookieJar, JSDOM, VirtualConsole } = rsdom;
  const {
    html = "<!DOCTYPE html>",
    userAgent,
    url = "http://localhost:3000",
    contentType = "text/html",
    pretendToBeVisual = true,
    includeNodeLocations = false,
    runScripts = "dangerously",
    resources,
    console = false,
    cookieJar = false,
    ...restOptions
  } = options;

  let virtualConsole;
  if (console && globalThis.console) {
    virtualConsole = new VirtualConsole();
    virtualConsole.forwardTo(globalThis.console);
  }
  return new JSDOM(html, {
    pretendToBeVisual,
    runScripts,
    url,
    virtualConsole,
    cookieJar: cookieJar ? new CookieJar() : undefined,
    includeNodeLocations,
    contentType,
    // jsdom 28+ (and so rsdom) takes the user agent through the resources option instead of a ResourceLoader.
    resources: userAgent ? { userAgent } : resources,
    ...restOptions
  });
}

// Vitest keys per-file `@vitest-environment-options` by the environment's name as written: "rsdom", or a path to this
// file. Config-level `environmentOptions` can use "rsdom" or "jsdom".
function environmentOptions(options) {
  const byPath = Object.keys(options).find(key => key.includes("rsdom"));
  return options.rsdom ?? (byPath ? options[byPath] : undefined) ?? options.jsdom ?? {};
}

function catchWindowErrors(window) {
  let userErrorListenerCount = 0;
  function throwUnhandledError(e) {
    if (userErrorListenerCount === 0 && e.error !== null && e.error !== undefined) {
      e.preventDefault();
      process.emit("uncaughtException", e.error);
    }
  }
  const addEventListener = window.addEventListener.bind(window);
  const removeEventListener = window.removeEventListener.bind(window);
  window.addEventListener("error", throwUnhandledError);
  window.addEventListener = function (...args) {
    if (args[0] === "error") {
      userErrorListenerCount++;
    }
    return addEventListener.apply(this, args);
  };
  window.removeEventListener = function (...args) {
    if (args[0] === "error" && userErrorListenerCount) {
      userErrorListenerCount--;
    }
    return removeEventListener.apply(this, args);
  };
  return function clearErrorHandlers() {
    window.removeEventListener("error", throwUnhandledError);
  };
}

// Node's fetch()/Request and URL.createObjectURL() only accept Node's Blob and FormData, so convert rsdom's.
function createCompatUtils(window) {
  const utils = {
    window,
    makeCompatFormData(formData) {
      const nodeFormData = new NodeFormData();
      formData.forEach((value, key) => {
        if (value instanceof window.Blob) {
          nodeFormData.append(key, utils.makeCompatBlob(value));
        } else {
          nodeFormData.append(key, value);
        }
      });
      return nodeFormData;
    },
    makeCompatBlob(blob) {
      return new NodeBlob([implForWrapper(blob)._bytes], { type: blob.type });
    }
  };
  return utils;
}

function createCompatRequest(utils) {
  return class Request extends NodeRequest {
    constructor(...args) {
      const [input, init] = args;
      if (init?.body !== null && init?.body !== undefined) {
        const compatInit = { ...init };
        if (init.body instanceof utils.window.Blob) {
          compatInit.body = utils.makeCompatBlob(init.body);
        }
        if (init.body instanceof utils.window.FormData) {
          compatInit.body = utils.makeCompatFormData(init.body);
        }
        super(input, compatInit);
      } else {
        super(...args);
      }
    }

    static [Symbol.hasInstance](instance) {
      return instance instanceof NodeRequest;
    }
  };
}

function createCompatURL(utils) {
  return class URL extends NodeURL {
    static createObjectURL(blob) {
      if (blob instanceof utils.window.Blob) {
        return NodeURL.createObjectURL(utils.makeCompatBlob(blob));
      }
      return NodeURL.createObjectURL(blob);
    }

    static [Symbol.hasInstance](instance) {
      return instance instanceof NodeURL;
    }
  };
}

// Node's AbortSignal (e.g. from a Node AbortController) isn't accepted by rsdom's addEventListener; map it to an
// rsdom AbortSignal that follows it.
function patchAddEventListener(window) {
  const abortControllers = new WeakMap();
  const WindowAbortSignal = window.AbortSignal;
  const WindowAbortController = window.AbortController;
  const originalAddEventListener = window.EventTarget.prototype.addEventListener;
  function getWindowAbortController(signal) {
    if (!abortControllers.has(signal)) {
      const controller = new WindowAbortController();
      signal.addEventListener("abort", () => {
        controller.abort(signal.reason);
      });
      abortControllers.set(signal, controller);
    }
    return abortControllers.get(signal);
  }
  window.EventTarget.prototype.addEventListener = function addEventListener(type, callback, options) {
    if (typeof options === "object" && options?.signal !== null && options?.signal !== undefined) {
      const { signal, ...otherOptions } = options;
      if (!(signal instanceof WindowAbortSignal)) {
        const compatOptions = Object.create(null);
        Object.assign(compatOptions, otherOptions);
        compatOptions.signal = getWindowAbortController(signal).signal;
        return originalAddEventListener.call(this, type, callback, compatOptions);
      }
    }
    return originalAddEventListener.call(this, type, callback, options);
  };
  return () => {
    window.EventTarget.prototype.addEventListener = originalAddEventListener;
  };
}

function createEnvironment(loadVitestRuntime) {
  return {
    name: "rsdom",
    viteEnvironment: "client",
    // Vitest 3 needs transformMode; Vitest 4+ deprecates it (with a warning) in favour of viteEnvironment.
    get transformMode() {
      return vitestMajor() < 4 ? "web" : undefined;
    },

    async setupVM(options) {
      let dom = createDOM(environmentOptions(options));
      const clearAddEventListenerPatch = patchAddEventListener(dom.window);
      const clearWindowErrors = catchWindowErrors(dom.window);
      const utils = createCompatUtils(dom.window);

      // Browsers don't have Buffer, but a lot of dependencies use it.
      dom.window.Buffer = NodeBuffer;
      dom.window.jsdom = dom;
      dom.window.Request = createCompatRequest(utils);
      dom.window.URL = createCompatURL(utils);
      for (const name of WINDOW_FILL_INS) {
        const value = globalThis[name];
        if (value !== undefined && dom.window[name] === undefined) {
          dom.window[name] = value;
        }
      }
      for (const name of NODE_OVERRIDES) {
        const value = globalThis[name];
        if (value !== undefined) {
          dom.window[name] = value;
        }
      }

      return {
        getVmContext() {
          return dom.getInternalVMContext();
        },
        teardown() {
          clearAddEventListenerPatch();
          clearWindowErrors();
          dom.window.close();
          dom = undefined;
        }
      };
    },

    async setup(global, options) {
      const { populateGlobal } = await loadVitestRuntime();
      const dom = createDOM(environmentOptions(options));
      const clearAddEventListenerPatch = patchAddEventListener(dom.window);
      const { keys, originals } = populateGlobal(global, dom.window, { bindFunctions: true });
      const clearWindowErrors = catchWindowErrors(global);
      const utils = createCompatUtils(dom.window);

      global.jsdom = dom;
      global.Request = createCompatRequest(utils);
      global.URL = createCompatURL(utils);

      return {
        teardown(teardownGlobal) {
          clearAddEventListenerPatch();
          clearWindowErrors();
          dom.window.close();
          delete teardownGlobal.jsdom;
          for (const key of keys) {
            delete teardownGlobal[key];
          }
          for (const [key, descriptor] of originals) {
            Object.defineProperty(teardownGlobal, key, descriptor);
          }
        }
      };
    }
  };
}

module.exports = createEnvironment(importVitestRuntime);
module.exports.default = module.exports;
module.exports.createEnvironment = createEnvironment;
