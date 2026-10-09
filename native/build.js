"use strict";
// Builds the Rust addon and copies it to native/jsdom-native.node.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const profile = process.argv.includes("--debug") ? "debug" : "release";
const args = ["build", "--manifest-path", path.join(__dirname, "Cargo.toml")];
if (profile === "release") {
  args.push("--release");
}
execFileSync("cargo", args, { stdio: "inherit" });

const targetDir = process.env.CARGO_TARGET_DIR || path.join(__dirname, "target");
const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const prefix = process.platform === "win32" ? "" : "lib";
const built = path.join(targetDir, profile, `${prefix}jsdom_native.${ext}`);
fs.copyFileSync(built, path.join(__dirname, "jsdom-native.node"));
