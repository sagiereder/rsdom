"use strict";
// Builds the Rust addon and copies it next to this file.
//
//   node src/native/build.js                  release build for the host, to src/native/jsdom-native.node
//   node src/native/build.js --debug          debug build for the host
//   node src/native/build.js --target wasm32-wasip1
//                                             the WebAssembly build, to src/native/jsdom-native.wasm (see
//                                             npm/wasm32-wasi/loader.js); needs `rustup target add wasm32-wasip1`
//   options for release builds (see .github/workflows/release.yml):
//     --target <triple>   cross-compile, e.g. aarch64-unknown-linux-gnu (a glibc suffix such as .2.17 needs --zig)
//     --zig               build with `cargo zigbuild` (cargo-zigbuild + zig), for Linux cross-compilation
//     --out <file>        where to copy the addon (default src/native/jsdom-native.node, or .wasm)
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const profile = argv.includes("--debug") ? "debug" : "release";
const target = opt("--target");
const zig = argv.includes("--zig");
const wasm = target?.startsWith("wasm32-wasi") ?? false;
const out = path.resolve(opt("--out") ?? path.join(__dirname, wasm ? "jsdom-native.wasm" : "jsdom-native.node"));

const env = { ...process.env };
if (wasm) {
  if (target !== "wasm32-wasip1") {
    // The loader instantiates the module without threads (no SharedArrayBuffer or workers needed), which only the
    // non-threaded emnapi archive supports.
    throw new Error(`Unsupported WebAssembly target ${target}; use wasm32-wasip1`);
  }
  // napi-build links the Node-API implementation for WebAssembly (emnapi) from this directory. The emnapi devDependency
  // must be the same version as the @emnapi/core and @emnapi/runtime the loader uses.
  env.EMNAPI_LINK_DIR = path.join(path.dirname(require.resolve("emnapi/package.json")), "lib", target);
}

const args = [zig ? "zigbuild" : "build", "--manifest-path", path.join(__dirname, "Cargo.toml")];
if (profile === "release") {
  args.push("--release");
}
if (target) {
  args.push("--target", target);
}
execFileSync("cargo", args, { stdio: "inherit", env });

// cargo-zigbuild accepts "<triple>.<glibc version>" but writes to target/<triple>/.
const triple = target?.replace(/\.\d+(\.\d+)*$/, "");
let os = process.platform;
if (wasm) {
  os = "wasi";
} else if (triple?.includes("windows")) {
  os = "win32";
} else if (triple?.includes("apple")) {
  os = "darwin";
} else if (triple) {
  os = "linux";
}
const fileName = {
  darwin: "libjsdom_native.dylib",
  win32: "jsdom_native.dll",
  wasi: "jsdom_native.wasm"
}[os] ?? "libjsdom_native.so";
const targetDir = process.env.CARGO_TARGET_DIR || path.join(__dirname, "target");
const built = path.join(targetDir, ...triple ? [triple] : [], profile, fileName);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
