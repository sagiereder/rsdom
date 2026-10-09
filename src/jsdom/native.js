"use strict";
const fs = require("node:fs");
const path = require("node:path");

// The Rust addon (src/native/) accelerates hot paths. It is looked up in this order:
//
//   1. the local development build, src/native/jsdom-native.node (`node src/native/build.js`);
//   2. the prebuilt binary from the per-platform npm package (@rsdom/core-<platform>, an optionalDependency);
//   3. nothing: rsdom uses the pure-JS fallbacks.
//
// Every failure is silent. JSDOM_NATIVE=0 forces the pure-JS fallbacks.

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

function load() {
  try {
    return require(path.resolve(__dirname, "../native/jsdom-native.node"));
  } catch {
    // Not a development checkout, or the addon has not been built.
  }
  try {
    return require(platformPackageName());
  } catch {
    // No prebuilt binary for this platform, or it was not installed (e.g. --no-optional).
  }
  return null;
}

module.exports = process.env.JSDOM_NATIVE === "0" ? null : load();
