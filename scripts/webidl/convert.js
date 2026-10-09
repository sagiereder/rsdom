/* eslint-disable no-console */

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Webidl2js = require("webidl2js");
const processReflect = require("./reflection.js");

const transformer = new Webidl2js({
  implSuffix: "-impl",
  suppressErrors: true,
  processCEReactions(code) {
    const preSteps = this.addImport("../../jsdom/living/helpers/custom-elements", "ceReactionsPreSteps");
    const postSteps = this.addImport("../../jsdom/living/helpers/custom-elements", "ceReactionsPostSteps");

    return `
      ${preSteps}(globalObject);
      try {
        ${code}
      } finally {
        ${postSteps}(globalObject);
      }
    `;
  },
  processHTMLConstructor() {
    const identifier = this.addImport("../../jsdom/living/helpers/html-constructor", "HTMLConstructor");

    return `
      return ${identifier}(globalObject, interfaceName, new.target);
    `;
  },
  processReflect(idl, implObj) {
    return processReflect(this, idl, implObj);
  }
});

function addDir(dir) {
  const resolved = path.resolve(__dirname, dir);
  transformer.addSource(resolved, resolved);
}

addDir("../../lib/jsdom/living/aborting");
addDir("../../lib/jsdom/living/aria");
addDir("../../lib/jsdom/living/attributes");
addDir("../../lib/jsdom/living/constraint-validation");
addDir("../../lib/jsdom/living/crypto");
addDir("../../lib/jsdom/living/css");
addDir("../../lib/jsdom/living/custom-elements");
addDir("../../lib/jsdom/living/deviceorientation");
addDir("../../lib/jsdom/living/domparsing");
addDir("../../lib/jsdom/living/encoding");
addDir("../../lib/jsdom/living/events");
addDir("../../lib/jsdom/living/fetch");
addDir("../../lib/jsdom/living/file-api");
addDir("../../lib/jsdom/living/geometry");
addDir("../../lib/jsdom/living/hr-time");
addDir("../../lib/jsdom/living/mutation-observer");
addDir("../../lib/jsdom/living/navigator");
addDir("../../lib/jsdom/living/nodes");
addDir("../../lib/jsdom/living/range");
addDir("../../lib/jsdom/living/selection");
addDir("../../lib/jsdom/living/svg");
addDir("../../lib/jsdom/living/traversal");
addDir("../../lib/jsdom/living/websockets");
addDir("../../lib/jsdom/living/webstorage");
addDir("../../lib/jsdom/living/window");
addDir("../../lib/jsdom/living/xhr");
addDir("../../lib/jsdom/living/webidl");

const outputDir = path.resolve(__dirname, "../../lib/generated/idl/");

// Clean up any old stuff lying around.
fs.rmSync(outputDir, { force: true, recursive: true, maxRetries: 2 });
fs.mkdirSync(outputDir, { recursive: true });

// Post-process the generated utils.js: a charCode-based fast path for isArrayIndexPropName, which every legacy
// platform object (HTMLCollection, NodeList, ...) proxy trap calls on each property access. Strings shorter than 10
// characters are array indices exactly when they are a canonical decimal integer, so they need no number conversion.
const ARRAY_INDEX_ORIGINAL = `function isArrayIndexPropName(P) {
  if (typeof P !== "string") {
    return false;
  }
  const i = P >>> 0;`;
const ARRAY_INDEX_FAST = `function isArrayIndexPropName(P) {
  if (typeof P !== "string") {
    return false;
  }
  const len = P.length;
  if (len === 0) {
    return false;
  }
  const c0 = P.charCodeAt(0);
  if (c0 < 48 || c0 > 57) {
    return false;
  }
  if (len < 10) {
    if (c0 === 48) {
      return len === 1;
    }
    for (let k = 1; k < len; k++) {
      const c = P.charCodeAt(k);
      if (c < 48 || c > 57) {
        return false;
      }
    }
    return true;
  }
  const i = P >>> 0;`;

function postProcessUtils() {
  const utilsPath = path.resolve(outputDir, "utils.js");
  const source = fs.readFileSync(utilsPath, "utf8");
  if (!source.includes(ARRAY_INDEX_ORIGINAL)) {
    throw new Error("convert.js: could not find isArrayIndexPropName in generated utils.js to post-process");
  }
  fs.writeFileSync(utilsPath, source.replace(ARRAY_INDEX_ORIGINAL, ARRAY_INDEX_FAST));
}

transformer.generate(outputDir)
  .then(postProcessUtils)
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
