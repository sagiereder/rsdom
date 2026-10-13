"use strict";
// Bundles the CommonJS modules that src/jsdom/living/css/helpers/patched-csstree.js loads (css-tree, its dependencies,
// and the csstools syntax patches) into one file, src/generated/css-tree-bundle.js.
//
// Loading css-tree through Node's module system means resolving, reading and compiling about 100 files, and its main
// module builds a default syntax (parsing every property and type definition) that patched-csstree.js only forks. With
// the bundle, loading is one file, and the patched syntax is built directly.
//
// The bundle contains the modules' sources unchanged, except that their require() calls of other bundled modules refer
// to those by id. It records the versions of the packages it contains; patched-csstree.js only uses it when they are
// the installed ones, and otherwise loads the packages normally. tests/api/css-startup.js checks that the syntax
// built from it is the one built from the installed packages.
const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const root = path.resolve(__dirname, "..");
const dest = path.resolve(root, "src/generated/css-tree-bundle.js");

const cssTreeDir = path.dirname(require.resolve("css-tree/package.json", { paths: [root] }));

// What patched-csstree.js needs: name -> file.
const entries = {
  patches: require.resolve("@csstools/css-syntax-patches-for-csstree", { paths: [root] }),
  createSyntax: path.join(cssTreeDir, "cjs/syntax/create.cjs"),
  mix: path.join(cssTreeDir, "cjs/syntax/config/mix.cjs"),
  lexerConfig: path.join(cssTreeDir, "cjs/syntax/config/lexer.cjs"),
  parserConfig: path.join(cssTreeDir, "cjs/syntax/config/parser.cjs"),
  walkerConfig: path.join(cssTreeDir, "cjs/syntax/config/walker.cjs"),
  tokenizer: path.join(cssTreeDir, "cjs/tokenizer/index.cjs"),
  string: path.join(cssTreeDir, "cjs/utils/string.cjs"),
  ident: path.join(cssTreeDir, "cjs/utils/ident.cjs"),
  definitionSyntax: path.join(cssTreeDir, "cjs/definition-syntax/index.cjs")
};

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

// The package.json of the package a file belongs to.
function packageJSONPathOf(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(path.join(dir, "package.json")) || !dir.split(path.sep).includes("node_modules")) {
    dir = path.dirname(dir);
  }
  // Skip package.json files of subdirectories (e.g. "type" markers) up to the one with the package's name.
  while (!JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")).name) {
    dir = path.dirname(dir);
  }
  return path.join(dir, "package.json");
}

// Modules whose exports are plain data computed from other modules, which the bundle contains instead of the modules
// (and the modules only they require). css-tree's data.cjs builds the property, type and at-rule definitions from
// mdn-data's (much larger) JSON files and css-tree's patches to them.
const precomputed = new Set([path.join(cssTreeDir, "cjs/data.cjs")]);

// file -> { id, source, requires: Map(specifier -> file) }
const modules = new Map();
// package.json path -> { name, version, requiredFrom }, where requiredFrom is the name of the package whose module
// first required it (null for jsdom itself), which is where patched-csstree.js resolves it from to check its version.
// This includes the packages of modules that only precomputed modules require.
const packages = new Map();

function addPackage(file, requiredFrom) {
  const packageJSONPath = packageJSONPathOf(file);
  if (!packages.has(packageJSONPath)) {
    const { name, version } = JSON.parse(fs.readFileSync(packageJSONPath, "utf-8"));
    packages.set(packageJSONPath, { name, version, requiredFrom });
  }
  return packages.get(packageJSONPath).name;
}

const REQUIRE = /\brequire\((['"])([^'"]+)\1\)/g;

// The files a module requires, by specifier.
function requiresOf(file, source) {
  const requires = new Map();
  if (!file.endsWith(".json")) {
    for (const [, , specifier] of source.matchAll(REQUIRE)) {
      if (!builtins.has(specifier)) {
        requires.set(specifier, require.resolve(specifier, { paths: [path.dirname(file)] }));
      }
    }
  }
  return requires;
}

function addModule(file, requiredFrom) {
  if (modules.has(file)) {
    return;
  }
  const packageName = addPackage(file, requiredFrom);
  const source = fs.readFileSync(file, "utf-8");
  const requires = requiresOf(file, source);
  modules.set(file, { id: String(modules.size), source, requires });

  if (precomputed.has(file)) {
    addPackagesOf(requires, packageName, new Set());
    return;
  }
  if (!file.endsWith(".json") &&
      /\b(__filename|__dirname|require\.|module\.(?!exports\b))/.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))) {
    throw new Error(`${file} uses more than require(), module.exports and exports, which is all the bundle provides`);
  }
  for (const required of requires.values()) {
    addModule(required, packageName);
  }
}

function addPackagesOf(requires, requiredFrom, seen) {
  for (const file of requires.values()) {
    if (!seen.has(file)) {
      seen.add(file);
      const packageName = addPackage(file, requiredFrom);
      addPackagesOf(requiresOf(file, fs.readFileSync(file, "utf-8")), packageName, seen);
    }
  }
}

for (const file of Object.values(entries)) {
  addModule(file, null);
}

// Checks that value is plain data that JSON represents exactly (except for prototypes: objects can have a null
// prototype, whose paths are collected in nullPrototypePaths), with no object reachable twice.
function checkPlainData(value, keyPath, nullPrototypePaths, seen) {
  if (typeof value === "string" || typeof value === "boolean" || value === null ||
      (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0))) {
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new Error(`Can't precompute the value at ${keyPath.join(".")}`);
  }
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!(isArray ? prototype === Array.prototype : prototype === Object.prototype || prototype === null) ||
      !Object.isExtensible(value) || Object.getOwnPropertySymbols(value).length > 0 ||
      Object.getOwnPropertyNames(value).length !== Object.keys(value).length + (isArray ? 1 : 0) ||
      (isArray && Object.keys(value).length !== value.length)) {
    throw new Error(`Can't precompute the value at ${keyPath.join(".")}`);
  }
  if (prototype === null) {
    nullPrototypePaths.push(keyPath);
  }
  for (const [key, item] of Object.entries(value)) {
    checkPlainData(item, [...keyPath, key], nullPrototypePaths, seen);
  }
}

function moduleFunction({ source, requires }, file) {
  if (precomputed.has(file)) {
    const value = require(file);
    const nullPrototypePaths = [];
    checkPlainData(value, [], nullPrototypePaths, new Set());
    const json = JSON.stringify(JSON.stringify(value));
    return `function (exports, require, module) {
module.exports = withNullPrototypes(JSON.parse(${json}), ${JSON.stringify(nullPrototypePaths)});
}`;
  }
  if (file.endsWith(".json")) {
    const json = JSON.stringify(JSON.stringify(JSON.parse(source)));
    return `function (exports, require, module) {\nmodule.exports = JSON.parse(${json});\n}`;
  }
  const body = source.replace(REQUIRE, (match, quote, specifier) => {
    return requires.has(specifier) ? `require(${modules.get(requires.get(specifier)).id})` : match;
  });
  return `function (exports, require, module) {\n${body}\n}`;
}

// The file's path from its node_modules directory, which is all the bundle says about where it came from.
function relativeName(file) {
  const parts = file.split(path.sep);
  return parts.slice(parts.lastIndexOf("node_modules") + 1).join("/");
}

const packageNames = [...packages.values()].map(({ name }) => name);
const packageList = [...packages.values()].map(({ name, version, requiredFrom }) => [name, version, requiredFrom]);
const output = `// This file is generated by scripts/generate-css-tree-bundle.js. Do not edit.
// It contains modules of the following packages, under their own licenses: ${packageNames.join(", ")}.

// The bundled packages: [name, version, name of the package that requires it (null for jsdom)].
exports.packages = ${JSON.stringify(packageList)};

// Runs the bundled modules (each on first require, as Node does) and returns the exports of the entries:
// ${Object.keys(entries).join(", ")}.
exports.load = function (builtinRequire) {
  const definitions = [
${[...modules].map(([file, module]) => `// ${relativeName(file)}\n${moduleFunction(module, file)}`).join(",\n")}
  ];
  const cache = [];
  // Replaces the objects at the given paths of value by copies with a null prototype.
  function withNullPrototypes(value, paths) {
    for (const keyPath of paths) {
      if (keyPath.length === 0) {
        value = Object.assign(Object.create(null), value);
      } else {
        const parent = keyPath.slice(0, -1).reduce((object, key) => object[key], value);
        const key = keyPath[keyPath.length - 1];
        parent[key] = Object.assign(Object.create(null), parent[key]);
      }
    }
    return value;
  }
  function bundledRequire(specifier) {
    if (typeof specifier === "string") {
      return builtinRequire(specifier);
    }
    if (cache[specifier] === undefined) {
      const module = { exports: {} };
      cache[specifier] = module;
      definitions[specifier].call(module.exports, module.exports, bundledRequire, module);
    }
    return cache[specifier].exports;
  }
  return {
${Object.entries(entries).map(([name, file]) => `    ${name}: bundledRequire(${modules.get(file).id})`).join(",\n")}
  };
};
`;

fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, output);
