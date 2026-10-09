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

addDir("../../src/jsdom/living/aborting");
addDir("../../src/jsdom/living/aria");
addDir("../../src/jsdom/living/attributes");
addDir("../../src/jsdom/living/constraint-validation");
addDir("../../src/jsdom/living/crypto");
addDir("../../src/jsdom/living/css");
addDir("../../src/jsdom/living/custom-elements");
addDir("../../src/jsdom/living/deviceorientation");
addDir("../../src/jsdom/living/domparsing");
addDir("../../src/jsdom/living/encoding");
addDir("../../src/jsdom/living/events");
addDir("../../src/jsdom/living/fetch");
addDir("../../src/jsdom/living/file-api");
addDir("../../src/jsdom/living/geometry");
addDir("../../src/jsdom/living/hr-time");
addDir("../../src/jsdom/living/mutation-observer");
addDir("../../src/jsdom/living/navigator");
addDir("../../src/jsdom/living/nodes");
addDir("../../src/jsdom/living/range");
addDir("../../src/jsdom/living/selection");
addDir("../../src/jsdom/living/svg");
addDir("../../src/jsdom/living/traversal");
addDir("../../src/jsdom/living/websockets");
addDir("../../src/jsdom/living/webstorage");
addDir("../../src/jsdom/living/window");
addDir("../../src/jsdom/living/xhr");
addDir("../../src/jsdom/living/webidl");

const outputDir = path.resolve(__dirname, "../../src/generated/idl/");

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

// Registers legacy platform object proxies with a single private field holding both the implementation and the
// interface: each private field added to a proxy costs a runtime call and dictionary insertion, unlike on ordinary
// objects.
const WRAPPER_LOOKUP_ORIGINAL = `  static implForWrapper(wrapper) {
    if (!isObject(wrapper) || !(#impl in wrapper)) {
      return null;
    }
    return wrapper.#impl;
  }

  static implForWrapperWithInterface(wrapper, interfaceDescriptor) {
    if (!isObject(wrapper) || !(#impl in wrapper)) {
      return null;
    }

    if (wrapper.#interfaceDescriptor?.inclusiveInheritedInterfaces[interfaceDescriptor.inheritanceDepth] !==
        interfaceDescriptor) {
      return null;
    }

    return wrapper.#impl;
  }
}

const { registerWrapper, implForWrapper, implForWrapperWithInterface } = WrapperData;
`;
const WRAPPER_LOOKUP_REPLACEMENT = `  static implForWrapper(wrapper) {
    if (!isObject(wrapper)) {
      return null;
    }
    if (#impl in wrapper) {
      return wrapper.#impl;
    }
    const data = ProxyWrapperData.dataFor(wrapper);
    return data === null ? null : data.impl;
  }

  static implForWrapperWithInterface(wrapper, interfaceDescriptor) {
    if (!isObject(wrapper)) {
      return null;
    }

    let impl, wrapperInterfaceDescriptor;
    if (#impl in wrapper) {
      impl = wrapper.#impl;
      wrapperInterfaceDescriptor = wrapper.#interfaceDescriptor;
    } else {
      const data = ProxyWrapperData.dataFor(wrapper);
      if (data === null) {
        return null;
      }
      ({ impl, interfaceDescriptor: wrapperInterfaceDescriptor } = data);
    }

    if (wrapperInterfaceDescriptor?.inclusiveInheritedInterfaces[interfaceDescriptor.inheritanceDepth] !==
        interfaceDescriptor) {
      return null;
    }

    return impl;
  }
}

class ProxyWrapperRecord {
  constructor(impl, interfaceDescriptor) {
    this.impl = impl;
    this.interfaceDescriptor = interfaceDescriptor;
  }
}

class ProxyWrapperData extends ReturnValue {
  #data;

  constructor(wrapper, data) {
    super(wrapper);
    this.#data = data;
  }

  static registerProxyWrapper(wrapper, impl, interfaceDescriptor) {
    return new ProxyWrapperData(wrapper, new ProxyWrapperRecord(impl, interfaceDescriptor));
  }

  static dataFor(wrapper) {
    return #data in wrapper ? wrapper.#data : null;
  }
}

const { registerWrapper, implForWrapper, implForWrapperWithInterface } = WrapperData;
const { registerProxyWrapper } = ProxyWrapperData;
`;

function postProcessUtils() {
  const utilsPath = path.resolve(outputDir, "utils.js");
  let source = fs.readFileSync(utilsPath, "utf8");
  for (const [original, replacement] of [
    [ARRAY_INDEX_ORIGINAL, ARRAY_INDEX_FAST],
    [WRAPPER_LOOKUP_ORIGINAL, WRAPPER_LOOKUP_REPLACEMENT],
    ["  registerWrapper,\n", "  registerWrapper,\n  registerProxyWrapper,\n"]
  ]) {
    if (!source.includes(original)) {
      throw new Error(`convert.js: could not post-process generated utils.js: ${original.split("\n")[0]} not found`);
    }
    source = source.replace(original, replacement);
  }
  fs.writeFileSync(utilsPath, source);
}

// Post-process the generated legacy platform object wrappers (the ones implemented as proxies):
//  - Proxy targets get a brand private to their module, so the traps find the implementation with a monomorphic
//    private field lookup instead of the megamorphic one in utils.implForWrapper().
//  - When the get trap falls through to the ordinary [[Get]] with the proxy itself as the receiver, it records the
//    proxy and its implementation, so that an accessor of the same interface invoked by that [[Get]] (such as
//    `length`) finds the implementation without a brand check on the proxy. The proxy's own registration is exactly
//    that implementation and this interface, so the shortcut returns what the brand check would.
const PROXY_TARGET_BRAND = `
class $ReturnValue {
  constructor(value) {
    // eslint-disable-next-line no-constructor-return
    return value;
  }
}

class $TargetBrand extends $ReturnValue {
  #impl;

  constructor(target, impl) {
    super(target);
    this.#impl = impl;
  }

  static implFor(target) {
    return target.#impl;
  }
}
`;

const PROXY_RECEIVER_CACHE = `
let $receiverProxy = null;
let $receiverImpl = null;
`;

function postProcessProxyWrapper(file) {
  let source = fs.readFileSync(file, "utf8");
  const handlerStart = source.indexOf("\nclass ProxyHandler {");
  if (handlerStart === -1) {
    return;
  }
  function fail(what) {
    throw new Error(`convert.js: could not post-process ${path.basename(file)}: ${what} not found`);
  }

  const register = "  utils.registerWrapper(wrapper, impl, undefined);\n";
  if (!source.includes(register)) {
    fail("makeProxy registration");
  }
  // The target's brand replaces its registration: only the traps look up the target's implementation.
  source = source.replace(register, "  new $TargetBrand(wrapper, impl);\n");
  const registerProxy = "  wrapper = makeProxy(wrapper, impl, globalObject";
  const proxyRegistration = "  utils.registerWrapper(wrapper, impl, $interfaceDescriptor);\n";
  let proxyRegistrations = 0;
  for (let i = source.indexOf(registerProxy); i !== -1; i = source.indexOf(registerProxy, i + 1)) {
    const at = source.indexOf(proxyRegistration, i);
    const nextProxy = source.indexOf(registerProxy, i + 1);
    if (at === -1 || (nextProxy !== -1 && nextProxy < at)) {
      fail("proxy registration");
    }
    source = `${source.slice(0, at)}  utils.registerProxyWrapper(wrapper, impl, $interfaceDescriptor);\n${
      source.slice(at + proxyRegistration.length)}`;
    proxyRegistrations++;
  }
  if (proxyRegistrations === 0) {
    fail("proxy registration");
  }

  let handler = source.slice(source.indexOf("\nclass ProxyHandler {"));
  const before = source.slice(0, source.length - handler.length);
  handler = handler.replaceAll("utils.implForWrapper(target)", "$TargetBrand.implFor(target)");

  const requireImpl = "function $requireImpl(wrapper, globalObject, context) {\n";
  const hasRequireImpl = before.includes(requireImpl);
  if (hasRequireImpl) {
    const getStart = handler.indexOf("\n  get(target, P, receiver) {\n");
    if (getStart === -1) {
      fail("get trap");
    }
    const getEnd = handler.indexOf("\n  }\n", getStart) + "\n  }\n".length;
    let get = handler.slice(getStart, getEnd);
    const tail = "\n    return Reflect.get(target, P, receiver);\n  }\n";
    if (!get.endsWith(tail) || !get.includes("\n    const impl = $TargetBrand.implFor(target);\n")) {
      fail("get trap fallthrough");
    }
    get = `${get.slice(0, -tail.length)}
    if (receiver === impl[utils.wrapperSymbol]) {
      $receiverProxy = receiver;
      $receiverImpl = impl;
      try {
        return Reflect.get(target, P, receiver);
      } finally {
        $receiverProxy = null;
        $receiverImpl = null;
      }
    }
    return Reflect.get(target, P, receiver);
  }
`;
    handler = handler.slice(0, getStart) + get + handler.slice(getEnd);
  }

  let head = before;
  if (hasRequireImpl) {
    head = head.replace(
      requireImpl,
      `${PROXY_RECEIVER_CACHE}\n${requireImpl}  if (wrapper === $receiverProxy) {\n    return $receiverImpl;\n  }\n`
    );
  }
  fs.writeFileSync(file, `${head}${PROXY_TARGET_BRAND}${handler}`);
}

// Converting a string to DOMString gives the same string, so operation arguments that already are strings skip the
// conversion call (and its options object).
function postProcessStringArguments(file) {
  const source = fs.readFileSync(file, "utf8");
  const call = `curArg = conversions["DOMString"](curArg, {`;
  if (source.includes(call)) {
    fs.writeFileSync(
      file,
      source.replaceAll(call, `curArg = typeof curArg === "string" ? curArg : conversions["DOMString"](curArg, {`)
    );
  }
}

function postProcessWrappers() {
  for (const name of fs.readdirSync(outputDir)) {
    if (name.endsWith(".js")) {
      const file = path.resolve(outputDir, name);
      postProcessProxyWrapper(file);
      postProcessStringArguments(file);
    }
  }
}

transformer.generate(outputDir)
  .then(postProcessUtils)
  .then(postProcessWrappers)
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
