"use strict";
// The prebuilt-binary platforms. Each one is published as its own npm package, @rsdom/core-<name>, from npm/<name>/,
// and listed in the main package's optionalDependencies. src/jsdom/native.js computes the same names at runtime.
module.exports = [
  { name: "darwin-arm64", target: "aarch64-apple-darwin", os: "darwin", cpu: "arm64" },
  { name: "darwin-x64", target: "x86_64-apple-darwin", os: "darwin", cpu: "x64" },
  { name: "linux-x64-gnu", target: "x86_64-unknown-linux-gnu", os: "linux", cpu: "x64", libc: "glibc" },
  { name: "linux-arm64-gnu", target: "aarch64-unknown-linux-gnu", os: "linux", cpu: "arm64", libc: "glibc" },
  { name: "linux-x64-musl", target: "x86_64-unknown-linux-musl", os: "linux", cpu: "x64", libc: "musl" },
  { name: "win32-x64-msvc", target: "x86_64-pc-windows-msvc", os: "win32", cpu: "x64" }
];
