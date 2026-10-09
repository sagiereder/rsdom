"use strict";
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");

// impl name -> { load(), env }. "fork-js" is the fork with the Rust addon disabled.
const IMPLS = {
  "upstream": { desc: "jsdom@30.1.2 from npm", env: {}, modulePath: () => require.resolve("jsdom-upstream") },
  "fork": { desc: "this repo (native enabled)", env: {}, modulePath: () => path.join(REPO_ROOT, "src/api.js") },
  "fork-js": { desc: "this repo, JSDOM_NATIVE=0", env: { JSDOM_NATIVE: "0" }, modulePath: () => path.join(REPO_ROOT, "src/api.js") }
};

// Directory prefix whose files belong to the given impl's jsdom lib (for profile attribution).
function libRoot(impl) {
  return impl === "upstream" ? path.dirname(require.resolve("jsdom-upstream")) : path.join(REPO_ROOT, "src");
}

function nativeLoaded(impl) {
  if (impl === "upstream") {
    return false;
  }
  try {
    return Boolean(require(path.join(REPO_ROOT, "src/jsdom/native.js")));
  } catch {
    return false;
  }
}

module.exports = { IMPLS, REPO_ROOT, libRoot, nativeLoaded };
