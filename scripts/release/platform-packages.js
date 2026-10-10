"use strict";
/* eslint-disable no-console */
// Maintains the per-platform binary packages in npm/<platform>/ (@rsdom/core-darwin-arm64 and so on).
//
//   node scripts/release/platform-packages.js sync
//       Rewrites every npm/<platform>/package.json from scripts/release/platforms.js, at the root package's version,
//       and moves the packages/* wrappers (@rsdom/jest, @rsdom/vitest, vitest-environment-rsdom) and their
//       @rsdom/core dependency to that version. Run it after bumping the version.
//   node scripts/release/platform-packages.js prepublish
//       Adds the platform packages to the root package.json's optionalDependencies, at the root version. CI runs this
//       just before `npm publish`. It is not committed: until a version's platform packages exist on the registry,
//       listing them would put package-lock.json out of sync and break `npm ci` (napi-rs's `napi prepublish` works
//       the same way).
//   node scripts/release/platform-packages.js copy <dir> [--allow-missing]
//       Copies the CI-built binaries, named rsdom.<platform>.node anywhere under <dir>, into npm/<platform>/.
//       Fails if a platform has no binary unless --allow-missing is given.
//   node scripts/release/platform-packages.js local
//       Copies the local development build (src/native/jsdom-native.node) into the host platform's package, so it can
//       be packed and installed to test the prebuilt-binary path without CI.
//   node scripts/release/platform-packages.js check
//       Fails unless every npm/<platform>/package.json and packages/* wrapper matches the root version.
const fs = require("node:fs");
const path = require("node:path");
const platforms = require("./platforms.js");

const root = path.resolve(__dirname, "../..");
const rootPkgPath = path.join(root, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const { version } = rootPkg;

function packageName(p) {
  return `${rootPkg.name}-${p.name}`;
}

function binaryName(p) {
  return `rsdom.${p.name}.node`;
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

function sync() {
  for (const p of platforms) {
    fs.mkdirSync(packageDir(p), { recursive: true });
    writeJSON(path.join(packageDir(p), "package.json"), manifest(p));
    fs.writeFileSync(
      path.join(packageDir(p), "README.md"),
      `# ${packageName(p)}\n\nThe \`${p.target}\` native addon for rsdom ` +
      `([${rootPkg.name}](https://www.npmjs.com/package/${rootPkg.name})). Don't install it directly: ` +
      `${rootPkg.name} lists it as an optional dependency, and npm installs the one that matches your platform.\n`
    );
  }
  for (const dir of wrapperDirs()) {
    writeJSON(path.join(dir, "package.json"), wrapperManifest(dir));
  }
  console.log(`Synced ${platforms.length} platform packages and ${wrapperDirs().length} wrappers to ${version}.`);
}

function prepublish() {
  rootPkg.optionalDependencies = Object.fromEntries(platforms.map(p => [packageName(p), version]));
  writeJSON(rootPkgPath, rootPkg);
  console.log(`Added ${platforms.length} platform packages to optionalDependencies at ${version}.`);
}

function check() {
  const problems = [];
  for (const p of platforms) {
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
  const found = findFiles(path.resolve(dir), new Set(platforms.map(binaryName)));
  const missing = [];
  for (const p of platforms) {
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
