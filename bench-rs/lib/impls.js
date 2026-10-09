"use strict";
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");

function happyDomVersion() {
  try {
    return require("happy-dom/package.json").version;
  } catch {
    return "?";
  }
}

// impl name -> { desc, env, kind, modulePath() }. "fork-js" is the fork with the Rust addon disabled.
// kind selects the adapter in createDomFactory(): "jsdom" (JSDOM API) or "happy-dom" (Window API).
const IMPLS = {
  "upstream": {
    desc: "jsdom@30.1.2 from npm", env: {}, kind: "jsdom", modulePath: () => require.resolve("jsdom-upstream")
  },
  "fork": {
    desc: "this repo (native enabled)", env: {}, kind: "jsdom", modulePath: () => path.join(REPO_ROOT, "lib/api.js")
  },
  "fork-js": {
    desc: "this repo, JSDOM_NATIVE=0", env: { JSDOM_NATIVE: "0" }, kind: "jsdom",
    modulePath: () => path.join(REPO_ROOT, "lib/api.js")
  },
  "happy-dom": {
    get desc() {
      return `happy-dom@${happyDomVersion()} from npm`;
    },
    env: {}, kind: "happy-dom", modulePath: () => require.resolve("happy-dom")
  }
};

const DEFAULT_HTML = "<!DOCTYPE html><html><head></head><body></body></html>";

// Returns createDom(html, opts) -> handle for the given impl. Every handle has the same shape, so scenarios stay
// impl-agnostic:
//   handle.window      the window object
//   handle.serialize() full-document HTML serialization (doctype + documentElement.outerHTML)
//   handle.close()     release the window (may return a promise; teardowns should return/await it)
// Supported opts (jsdom option names): url, runScripts ("dangerously" enables script evaluation).
function createDomFactory(implName) {
  const impl = IMPLS[implName];
  if (!impl) {
    throw new Error(`unknown impl ${implName}`);
  }
  if (impl.kind === "jsdom") {
    const { JSDOM } = require(impl.modulePath());
    return (html = DEFAULT_HTML, opts = {}) => {
      const dom = new JSDOM(html, opts);
      return {
        window: dom.window,
        serialize: () => dom.serialize(),
        close: () => dom.window.close()
      };
    };
  }
  if (impl.kind === "happy-dom") {
    const { Window } = require(impl.modulePath());
    return (html = DEFAULT_HTML, opts = {}) => {
      const settings = {};
      if (opts.runScripts === "dangerously") {
        settings.enableJavaScriptEvaluation = true;
      }
      const window = new Window({ url: opts.url || "about:blank", settings });
      // happy-dom's documented way to load a full HTML document into a window.
      window.document.write(html);
      return {
        window,
        serialize() {
          const { doctype, documentElement } = window.document;
          return (doctype ? `<!DOCTYPE ${doctype.name}>` : "") + documentElement.outerHTML;
        },
        // happy-dom may have pending async work (timers, fetches); close() aborts it and frees the window.
        close: () => window.happyDOM.close()
      };
    };
  }
  throw new Error(`unknown impl kind ${impl.kind}`);
}

// Directory prefix whose files belong to the given impl's DOM lib (for profile attribution).
function libRoot(impl) {
  if (impl === "upstream") {
    return path.dirname(require.resolve("jsdom-upstream"));
  }
  if (impl === "happy-dom") {
    return path.dirname(require.resolve("happy-dom/package.json"));
  }
  return path.join(REPO_ROOT, "lib");
}

function nativeLoaded(impl) {
  if (IMPLS[impl].kind !== "jsdom" || impl === "upstream") {
    return false;
  }
  try {
    return Boolean(require(path.join(REPO_ROOT, "lib/jsdom/native.js")));
  } catch {
    return false;
  }
}

module.exports = { IMPLS, REPO_ROOT, createDomFactory, libRoot, nativeLoaded };
