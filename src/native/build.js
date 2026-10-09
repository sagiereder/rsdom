"use strict";
// Builds the Rust addon and copies it to src/native/jsdom-native.node.
//
//   node src/native/build.js                  release build for the host
//   node src/native/build.js --debug          debug build for the host
//   options for release builds (see .github/workflows/release.yml):
//     --target <triple>   cross-compile, e.g. aarch64-unknown-linux-gnu (a glibc suffix such as .2.17 needs --zig)
//     --zig               build with `cargo zigbuild` (cargo-zigbuild + zig), for Linux cross-compilation
//     --out <file>        where to copy the addon (default src/native/jsdom-native.node)
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
const out = path.resolve(opt("--out") ?? path.join(__dirname, "jsdom-native.node"));

const args = [zig ? "zigbuild" : "build", "--manifest-path", path.join(__dirname, "Cargo.toml")];
if (profile === "release") {
  args.push("--release");
}
if (target) {
  args.push("--target", target);
}
execFileSync("cargo", args, { stdio: "inherit" });

// cargo-zigbuild accepts "<triple>.<glibc version>" but writes to target/<triple>/.
const triple = target?.replace(/\.\d+(\.\d+)*$/, "");
let os = process.platform;
if (triple?.includes("windows")) {
  os = "win32";
} else if (triple?.includes("apple")) {
  os = "darwin";
} else if (triple) {
  os = "linux";
}
const ext = { darwin: "dylib", win32: "dll" }[os] ?? "so";
const prefix = os === "win32" ? "" : "lib";
const targetDir = process.env.CARGO_TARGET_DIR || path.join(__dirname, "target");
const built = path.join(targetDir, ...triple ? [triple] : [], profile, `${prefix}jsdom_native.${ext}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(built, out);
