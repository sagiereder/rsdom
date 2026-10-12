"use strict";
/* eslint-disable no-console */
// Maintains the per-platform binary packages in npm/<platform>/ (@rsdom/core-darwin-arm64 and so on), and the
// WebAssembly build's package in npm/wasm32-wasi/ (@rsdom/core-wasm32-wasi: the module plus its loader, loader.js).
//
//   node scripts/release/platform-packages.js sync
//       Rewrites every npm/<platform>/package.json (and npm/wasm32-wasi/package.json) from
//       scripts/release/platforms.js, at the root package's version,
//       and moves the packages/* wrappers (@rsdom/jest, @rsdom/vitest, vitest-environment-rsdom) and their
//       @rsdom/core dependency to that version. Run it after bumping the version.
//   node scripts/release/platform-packages.js prepublish
//       Adds the platform packages to the root package.json's optionalDependencies, and the WebAssembly package to its
//       dependencies, at the root version. CI runs this just before `npm publish`. It is not committed: until a
//       version's packages exist on the registry, listing them would put package-lock.json out of sync and break
//       `npm ci` (napi-rs's `napi prepublish` works the same way). The WebAssembly package is a regular dependency, so
//       that installs without optional dependencies, or with a lockfile missing this platform's package, still work.
//   node scripts/release/platform-packages.js copy <dir> [--allow-missing]
//       Copies the CI-built binaries, named rsdom.<platform>.node (and rsdom.wasm32-wasi.wasm) anywhere under <dir>,
//       into npm/<platform>/.
//       Fails if a platform has no binary unless --allow-missing is given.
//   node scripts/release/platform-packages.js local
//       Copies the local development build (src/native/jsdom-native.node) into the host platform's package, and the
//       local WebAssembly build (src/native/jsdom-native.wasm), if any, into npm/wasm32-wasi/, so they can be packed
//       and installed to test the published loading paths without CI.
//   node scripts/release/platform-packages.js check
//       Fails unless every npm/<platform>/package.json and packages/* wrapper matches the root version, and the emnapi
//       build dependency matches the emnapi runtime the WebAssembly loader uses.
const fs = require("node:fs");
const path = require("node:path");
const platforms = require("./platforms.js");

// The WebAssembly build. It has no os/cpu/libc constraints: it is the fallback for every platform.
const wasm = { name: "wasm32-wasi", target: "wasm32-wasip1", wasm: true };
const packages = [...platforms, wasm];
// The runtime dependencies of npm/wasm32-wasi/loader.js, at the versions the root package develops against.
const WASM_RUNTIME = ["@emnapi/core", "@emnapi/runtime", "@tybys/wasm-util"];

const root = path.resolve(__dirname, "../..");
const rootPkgPath = path.join(root, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const { version } = rootPkg;

function packageName(p) {
  return `${rootPkg.name}-${p.name}`;
}

function binaryName(p) {
  return `rsdom.${p.name}.${p.wasm ? "wasm" : "node"}`;
}

function packageDir(p) {
  return path.join(root, "npm", p.name);
}

function wrapperDirs() {
  return fs.readdirSync(path.join(root, "packages")).map(name => path.join(root, "packages", name));
}

function wrapperManifest(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return { ...pkg, version, dependencies: { ...pkg.dependencies, [rootPkg.name]: version } };
}

function manifest(p) {
  if (p.wasm) {
    return {
      name: packageName(p),
      version,
      description: "The WebAssembly build of rsdom's Rust core, used where no prebuilt native binary is available",
      license: rootPkg.license,
      repository: rootPkg.repository,
      main: "index.js",
      files: ["index.js", "loader.js", binaryName(p)],
      publishConfig: { access: "public" },
      dependencies: Object.fromEntries(WASM_RUNTIME.map(name => [name, rootPkg.devDependencies[name]])),
      engines: rootPkg.engines
    };
  }
  return {
    name: packageName(p),
    version,
    description: `The ${p.target} binary for rsdom, a jsdom fork with a Rust core`,
    license: rootPkg.license,
    repository: rootPkg.repository,
    main: binaryName(p),
    files: [binaryName(p)],
    publishConfig: { access: "public" },
    os: [p.os],
    cpu: [p.cpu],
    ...p.libc ? { libc: [p.libc] } : {},
    engines: rootPkg.engines
  };
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function readme(p) {
  const core = `[${rootPkg.name}](https://www.npmjs.com/package/${rootPkg.name})`;
  if (p.wasm) {
    return `# ${packageName(p)}\n\nThe WebAssembly (\`${p.target}\`) build of rsdom's Rust core, for ${core}. ` +
      `Don't install it directly: ${rootPkg.name} depends on it, and uses it when no prebuilt native binary is ` +
      `installed for your platform (or when \`JSDOM_NATIVE=wasm\` is set). It runs without threads, so it needs ` +
      `neither SharedArrayBuffer nor cross-origin isolation.\n`;
  }
  return `# ${packageName(p)}\n\nThe \`${p.target}\` native addon for rsdom (${core}). Don't install it directly: ` +
    `${rootPkg.name} lists it as an optional dependency, and npm installs the one that matches your platform.\n`;
}

function sync() {
  for (const p of packages) {
    fs.mkdirSync(packageDir(p), { recursive: true });
    writeJSON(path.join(packageDir(p), "package.json"), manifest(p));
    fs.writeFileSync(path.join(packageDir(p), "README.md"), readme(p));
  }
  for (const dir of wrapperDirs()) {
    writeJSON(path.join(dir, "package.json"), wrapperManifest(dir));
  }
  console.log(`Synced ${packages.length} platform packages and ${wrapperDirs().length} wrappers to ${version}.`);
}

function prepublish() {
  rootPkg.optionalDependencies = Object.fromEntries(platforms.map(p => [packageName(p), version]));
  rootPkg.dependencies = { ...rootPkg.dependencies, [packageName(wasm)]: version };
  writeJSON(rootPkgPath, rootPkg);
  console.log(`Added ${platforms.length} platform packages to optionalDependencies and ${packageName(wasm)} to ` +
    `dependencies at ${version}.`);
}

function check() {
  const problems = [];
  for (const p of packages) {
    const file = path.join(packageDir(p), "package.json");
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (actual !== JSON.stringify(manifest(p), null, 2) + "\n") {
      problems.push(`${path.relative(root, file)} is out of date`);
    }
  }
  for (const dir of wrapperDirs()) {
    const file = path.join(dir, "package.json");
    if (fs.readFileSync(file, "utf8") !== JSON.stringify(wrapperManifest(dir), null, 2) + "\n") {
      problems.push(`${path.relative(root, file)} is out of date`);
    }
  }
  // The WebAssembly module links emnapi's Node-API implementation (the emnapi devDependency, see src/native/build.js)
  // and is driven at runtime by @emnapi/core and @emnapi/runtime: all three must be the same version.
  const emnapiVersions = ["emnapi", "@emnapi/core", "@emnapi/runtime"].map(name => rootPkg.devDependencies[name]);
  if (new Set(emnapiVersions).size !== 1 || !/^\d/u.test(emnapiVersions[0])) {
    problems.push(`emnapi, @emnapi/core and @emnapi/runtime must be devDependencies pinned to one exact version ` +
      `(found ${emnapiVersions.join(", ")})`);
  }
  if (problems.length > 0) {
    console.error(problems.join("\n") + "\nRun `node scripts/release/platform-packages.js sync`.");
    process.exit(1);
  }
  console.log(`All platform packages are at ${version}.`);
}

function findFiles(dir, names, found = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(full, names, found);
    } else if (names.has(entry.name)) {
      found.set(entry.name, full);
    }
  }
  return found;
}

function copy(dir, allowMissing) {
  if (!dir) {
    throw new Error("usage: platform-packages.js copy <dir> [--allow-missing]");
  }
  const found = findFiles(path.resolve(dir), new Set(packages.map(binaryName)));
  const missing = [];
  for (const p of packages) {
    const src = found.get(binaryName(p));
    if (!src) {
      missing.push(binaryName(p));
      continue;
    }
    fs.copyFileSync(src, path.join(packageDir(p), binaryName(p)));
    console.log(`${path.relative(root, src)} -> npm/${p.name}/${binaryName(p)}`);
  }
  if (missing.length > 0) {
    console.error(`Missing binaries: ${missing.join(", ")}`);
    if (!allowMissing) {
      process.exit(1);
    }
  }
}

function hostPlatform() {
  let libc;
  if (process.platform === "linux") {
    const { glibcVersionRuntime } = process.report.getReport().header;
    libc = glibcVersionRuntime ? "glibc" : "musl";
  }
  const p = platforms.find(c => c.os === process.platform && c.cpu === process.arch && c.libc === libc);
  if (!p) {
    throw new Error(`No rsdom platform package for ${process.platform}-${process.arch}`);
  }
  return p;
}

function local() {
  const p = hostPlatform();
  const src = path.join(root, "src/native/jsdom-native.node");
  if (!fs.existsSync(src)) {
    throw new Error("src/native/jsdom-native.node is missing; run `node src/native/build.js` first");
  }
  fs.copyFileSync(src, path.join(packageDir(p), binaryName(p)));
  console.log(`src/native/jsdom-native.node -> npm/${p.name}/${binaryName(p)}`);
  const wasmSrc = path.join(root, "src/native/jsdom-native.wasm");
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(packageDir(wasm), binaryName(wasm)));
    console.log(`src/native/jsdom-native.wasm -> npm/${wasm.name}/${binaryName(wasm)}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "sync":
    sync();
    break;
  case "prepublish":
    prepublish();
    break;
  case "check":
    check();
    break;
  case "copy":
    copy(rest.find(a => !a.startsWith("--")), rest.includes("--allow-missing"));
    break;
  case "local":
    local();
    break;
  default:
    console.error("usage: platform-packages.js sync | prepublish | check | copy <dir> [--allow-missing] | local");
    process.exit(1);
}
