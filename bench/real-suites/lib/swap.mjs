// Rewrites a project's Jest or Vitest config so its DOM test environment is the implementation being measured. The
// harness generates a small wrapper config next to the project's own config (so rootDir and relative paths resolve the
// same way) that imports the original and passes it through here; the impl comes from REAL_SUITES_IMPL.
//
// Only DOM environments are touched: node environments (e.g. react-hook-form's "server" project, radix's "rsc"
// project) run unchanged. Per-file docblocks (`@vitest-environment jsdom`) can't be rewritten from the config, so
// those files stay on jsdom under every impl; the manifest notes where that happens.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENVS_DIR = path.join(HERE, "envs");
const REPO_ROOT = path.resolve(HERE, "../..");

// Jest runs the project's code transform (babel-jest, esbuild-jest, ...) over the test environment module and everything
// it requires while loading it, skipping only files matching transformIgnorePatterns (default: /node_modules/). In real
// use @rsdom/jest and jsdom live in node_modules and load untransformed; here the environment and rsdom's sources live
// in this repo, so exclude them explicitly or the project's transform would rewrite rsdom (and fail, e.g. downshift's
// Babel config injects @babel/runtime helpers it can't resolve from here).
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HARNESS_IGNORE = `^${escape(REPO_ROOT)}/(src|bench/real-suites/(lib|envs|node_modules))/`;
const DEFAULT_TRANSFORM_IGNORE = ["/node_modules/", "\\.pnp\\.[^\\/]+$"];

const JEST_DOM_ENVS = {
  "jsdom": "plain",
  "jest-environment-jsdom": "plain",
  "jest-fixed-jsdom": "fixed"
};

function currentImpl() {
  const impl = process.env.REAL_SUITES_IMPL;
  if (!["jsdom", "jsdom30", "rsdom", "happy-dom"].includes(impl)) {
    throw new Error(`REAL_SUITES_IMPL must be jsdom, jsdom30, rsdom or happy-dom (got ${impl})`);
  }
  return impl;
}

async function resolveConfig(config, ...args) {
  let value = await config;
  if (value && typeof value === "object" && "default" in value && Object.keys(value).length === 1) {
    value = value.default;
  }
  if (typeof value === "function") {
    value = await value(...args);
  }
  return value;
}

export async function swapJestConfig(original) {
  const impl = currentImpl();
  const config = await resolveConfig(original);
  if (impl === "jsdom") {
    return config;
  }
  let swapped = 0;
  const swap = project => {
    const kind = JEST_DOM_ENVS[project.testEnvironment];
    if (!kind) {
      return project;
    }
    swapped++;
    const file = `jest-${impl}${kind === "fixed" ? "-fixed" : ""}.cjs`;
    return {
      ...project,
      testEnvironment: path.join(ENVS_DIR, file),
      transformIgnorePatterns: [...(project.transformIgnorePatterns ?? DEFAULT_TRANSFORM_IGNORE), HARNESS_IGNORE]
    };
  };
  let result = swap(config);
  if (Array.isArray(config.projects)) {
    result = {
      ...result,
      projects: config.projects.map(project => {
        if (typeof project !== "object") {
          throw new Error(`can't swap the environment of a Jest project given by path (${project})`);
        }
        return swap(project);
      })
    };
  }
  if (swapped === 0) {
    throw new Error("no jsdom testEnvironment found to swap in the Jest config");
  }
  return result;
}

export async function swapVitestConfig(original, env) {
  const impl = currentImpl();
  const config = await resolveConfig(original, env);
  let swapped = 0;
  const target = impl === "jsdom" ? "jsdom" : path.join(ENVS_DIR, `vitest-${impl}.mjs`);
  const swapTest = test => {
    if (!test || !["jsdom", "happy-dom"].includes(test.environment)) {
      return test;
    }
    swapped++;
    return { ...test, environment: target };
  };
  const test = swapTest(config.test);
  const projects = config.test?.projects?.map(project => {
    if (typeof project !== "object" || typeof project === "function") {
      throw new Error(`can't swap the environment of a Vitest project given by path or function (${project})`);
    }
    return { ...project, test: swapTest(project.test) };
  });
  if (swapped === 0) {
    throw new Error("no jsdom/happy-dom environment found to swap in the Vitest config");
  }
  return { ...config, test: { ...test, ...(projects ? { projects } : {}) } };
}
