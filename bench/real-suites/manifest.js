"use strict";
// The real open-source test suites the harness runs. Each is pinned to a commit and cloned into .cache/<name>.
//
//   install   commands run once in the clone (argv arrays), with CI=1
//   runner    "jest" or "vitest"
//   config    the project's own config file, relative to the clone. run.js writes a wrapper config next to it
//             (wrapper) that imports it and swaps the DOM environment for REAL_SUITES_IMPL (see lib/swap.mjs)
//   command   the test command (argv array). {config} is the wrapper, {out} the JSON results file. Every impl runs the
//             exact same command; only REAL_SUITES_IMPL differs.
//   env       extra environment variables the project's own test script sets
//   notes     anything that differs from the project's own `npm test`

// Same for every project and impl, so worker count doesn't vary with machine load.
const WORKERS = "--maxWorkers=4";

module.exports = [
  {
    name: "react-hook-form",
    repo: "https://github.com/react-hook-form/react-hook-form",
    commit: "7ba651ab94586fb723d10daf0dfd8e351f5f0834",
    runner: "jest",
    install: [["corepack", "pnpm@12.10.1", "install", "--frozen-lockfile"]],
    config: "scripts/jest/jest.config.js",
    wrapper: "scripts/jest/jest.realsuites.config.mjs",
    command: ["node", "node_modules/jest/bin/jest.js", "--config", "{config}", "--ci", WORKERS, "--json",
      "--outputFile={out}"],
    notes: "Jest 30 + jest-fixed-jsdom (jsdom 26). The node-environment \"server\" project runs unchanged under " +
      "every impl; the swapped environments keep jest-fixed-jsdom's Node globals."
  },
  {
    name: "downshift",
    repo: "https://github.com/downshift-js/downshift",
    commit: "1bb8b75e506fe807a5c5201a103d1bd128e5a5e2",
    runner: "jest",
    install: [["npm", "install", "--no-audit", "--no-fund"]],
    config: "jest.config.js",
    wrapper: "jest.realsuites.config.mjs",
    // `kcd-scripts test` = these env vars + jest with this config.
    env: { BABEL_ENV: "test", NODE_ENV: "test" },
    command: ["node", "node_modules/jest/bin/jest.js", "--config", "{config}", "--ci", WORKERS, "--json",
      "--outputFile={out}"],
    notes: "Jest 29 via kcd-scripts (jsdom 20), Babel transform. No lockfile upstream (package-lock=false), so " +
      "dependency versions float."
  },
  {
    name: "mantine",
    repo: "https://github.com/mantinedev/mantine",
    commit: "e243f7f999b3250c0babe6c6aa6dba9bcb4aa836",
    runner: "jest",
    install: [["corepack", "yarn@4.18.0", "install", "--immutable"]],
    config: "jest.config.ts",
    wrapper: "jest.realsuites.config.mjs",
    command: ["node", "node_modules/jest/bin/jest.js", "--config", "{config}", "--ci", WORKERS, "--json",
      "--outputFile={out}", "packages/@mantine/core/"],
    notes: "Jest 30 + jest-environment-jsdom (jsdom 26), esbuild-jest transform. Runs @mantine/core only " +
      "(the full monorepo suite is several times longer)."
  },
  {
    name: "radix-primitives",
    dir: "primitives",
    repo: "https://github.com/radix-ui/primitives",
    commit: "e46b65900b0c8243dad96dae0f1d44321fa1ff72",
    runner: "vitest",
    install: [["corepack", "pnpm@11.5.0", "install", "--frozen-lockfile"]],
    config: "vitest.config.mts",
    wrapper: "vitest.realsuites.config.mts",
    command: ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "{config}", WORKERS, "--reporter=json",
      "--outputFile={out}"],
    notes: "Vitest 4 (jsdom 29). The node-environment \"rsc\" project runs unchanged under every impl."
  },
  {
    name: "ariakit",
    repo: "https://github.com/ariakit/ariakit",
    commit: "88a92295093065502b6b9db2554f040cf9997a11",
    runner: "vitest",
    install: [["corepack", "pnpm@12.11.1", "install", "--frozen-lockfile"]],
    config: "vitest.config.ts",
    wrapper: "vitest.realsuites.config.mts",
    command: ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "{config}", WORKERS, "--reporter=json",
      "--outputFile={out}", "--project", "react", "--project", "dom"],
    notes: "Vitest 5. Upstream runs its DOM projects on happy-dom 20.14.6 (the impl here is the same version); " +
      "jsdom 30.1.2 is also installed. Runs the react and dom projects (not solid, not node). Six files pin " +
      "`@vitest-environment jsdom` and stay on jsdom under every impl."
  },
  {
    name: "react-redux",
    repo: "https://github.com/reduxjs/react-redux",
    commit: "14ef3ca025048e3dcf1d87af64ff71b94571a471",
    runner: "vitest",
    install: [["corepack", "pnpm@11.23.0", "install", "--frozen-lockfile"]],
    config: "vitest.config.mts",
    wrapper: "vitest.realsuites.config.mts",
    command: ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "{config}", WORKERS, "--reporter=json",
      "--outputFile={out}"],
    notes: "Vitest 4 (jsdom 25). Runtime tests only (upstream also passes --typecheck, which runs tsc)."
  }
];
