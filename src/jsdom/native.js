"use strict";
const fs = require("node:fs");
const path = require("node:path");

// rsdom's Rust core (src/native/) is required: there is no pure-JS fallback. It is loaded once, as either
//
//   1. a native Node-API addon:
//      a. the local development build, src/native/jsdom-native.node (`node src/native/build.js`), or
//      b. the prebuilt binary from this platform's npm package (@rsdom/core-<platform>, an optionalDependency);
//   2. the WebAssembly build of the same crate, which runs anywhere WebAssembly does:
//      a. the local development build, src/native/jsdom-native.wasm
//         (`node src/native/build.js --target wasm32-wasip1`), or
//      b. the @rsdom/core-wasm32-wasi package (a dependency);
//
// in that order, and if none loads, requiring rsdom throws. Both builds have the same exports.
//
// The JSDOM_NATIVE environment variable overrides the order:
//   unset, "" or "1"  the order above
//   "native"          only 1 (the native addon), for checking that a native binary is in use
//   "wasm"            only 2 (WebAssembly), even where a native binary is available
//   "0"               same as "wasm". It used to select pure-JS fallbacks, which no longer exist; it now means
//                     "without the native binary".

const MODES = new Map([
  ["", "auto"],
  ["1", "auto"],
  ["native", "native"],
  ["wasm", "wasm"],
  ["0", "wasm"]
]);

function isMusl() {
  try {
    return fs.readFileSync("/usr/bin/ldd", "latin1").includes("musl");
  } catch {
    // No ldd (e.g. distroless images): ask the process report.
  }
  try {
    const { header } = process.report.getReport();
    return !header.glibcVersionRuntime;
  } catch {
    return false;
  }
}

function platformPackageName() {
  const { platform, arch } = process;
  if (platform === "linux") {
    return `@rsdom/core-linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
  }
  if (platform === "win32") {
    return `@rsdom/core-win32-${arch}-msvc`;
  }
  return `@rsdom/core-${platform}-${arch}`;
}

const WASM_PACKAGE = "@rsdom/core-wasm32-wasi";

// Whether `error` says that `request` itself is not installed (and not, say, one of its dependencies).
function isNotFound(error, request) {
  return error?.code === "MODULE_NOT_FOUND" && error.message.startsWith(`Cannot find module '${request}'`);
}

// Each candidate returns the exports, or undefined if it is not installed; a candidate that is installed but fails to
// load is recorded in `failures`, and the next one is tried.
function nativeCandidates() {
  const devBuild = path.resolve(__dirname, "../native/jsdom-native.node");
  const packageName = platformPackageName();
  return [
    {
      what: `the development build ${devBuild}`,
      missing: "is not built",
      load() {
        return fs.existsSync(devBuild) ? require(devBuild) : undefined;
      }
    },
    {
      what: `the prebuilt binary package ${packageName}`,
      missing: "is not installed",
      load() {
        try {
          return require(packageName);
        } catch (e) {
          if (isNotFound(e, packageName)) {
            return undefined;
          }
          throw e;
        }
      }
    }
  ];
}

function wasmCandidates() {
  const devBuild = path.resolve(__dirname, "../native/jsdom-native.wasm");
  // The loader is part of the WebAssembly package; a development checkout has it in npm/wasm32-wasi/.
  const devLoader = path.resolve(__dirname, "../../npm/wasm32-wasi/loader.js");
  return [
    {
      what: `the development build ${devBuild}`,
      missing: "is not built",
      load() {
        return fs.existsSync(devBuild) && fs.existsSync(devLoader) ? require(devLoader).load(devBuild) : undefined;
      }
    },
    {
      what: `the WebAssembly package ${WASM_PACKAGE}`,
      missing: "is not installed",
      load() {
        try {
          return require(WASM_PACKAGE);
        } catch (e) {
          if (isNotFound(e, WASM_PACKAGE)) {
            return undefined;
          }
          throw e;
        }
      }
    }
  ];
}

function load() {
  const setting = process.env.JSDOM_NATIVE ?? "";
  const mode = MODES.get(setting);
  if (mode === undefined) {
    throw new Error(`rsdom: unsupported JSDOM_NATIVE value ${JSON.stringify(setting)}; use "native", "wasm" or ` +
      `leave it unset`);
  }

  const candidates = [
    ...mode === "wasm" ? [] : nativeCandidates(),
    ...mode === "native" ? [] : wasmCandidates()
  ];
  const tried = [];
  for (const candidate of candidates) {
    let binding;
    try {
      binding = candidate.load();
    } catch (e) {
      tried.push(`  - ${candidate.what} failed to load: ${e?.message ?? e}`);
      continue;
    }
    if (binding !== undefined) {
      return binding;
    }
    tried.push(`  - ${candidate.what} ${candidate.missing}`);
  }

  const advice = mode === "native" ?
    `JSDOM_NATIVE=native requires the native addon. Reinstall @rsdom/core with optional dependencies enabled, so ` +
    `that npm installs ${platformPackageName()}, or (in a development checkout) run \`node src/native/build.js\`.` :
    `Reinstall @rsdom/core so that its ${WASM_PACKAGE} dependency is installed (it works on every platform), or, ` +
    `in a development checkout, run \`node src/native/build.js\` (native) or ` +
    `\`node src/native/build.js --target wasm32-wasip1\` (WebAssembly).`;
  throw new Error(`rsdom could not load its Rust core (${process.platform}-${process.arch}, ` +
    `JSDOM_NATIVE=${setting === "" ? "<unset>" : setting}). Tried:\n${tried.join("\n")}\n${advice}`);
}

module.exports = load();
