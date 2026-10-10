# @rsdom/vitest

A [Vitest](https://vitest.dev/) environment backed by rsdom ([@rsdom/core](https://www.npmjs.com/package/@rsdom/core)), a drop-in fork of jsdom with a Rust core. It is a mirror of Vitest's built-in `jsdom` environment.

```sh
npm install --save-dev @rsdom/vitest
```

```js
// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "./node_modules/@rsdom/vitest",
    // Optional: the same options as Vitest's jsdom environment. `environmentOptions.jsdom` works too.
    environmentOptions: { rsdom: { url: "http://localhost:3000" } }
  }
});
```

Give the environment as a path, not as `"@rsdom/vitest"`. Vitest looks up any name other than its built-in environments as the package `vitest-environment-<name>`, so a scoped package name can't be resolved. A path that starts with `.` or `/` is loaded as a file, relative to the project root. If `node_modules/@rsdom/vitest` isn't under the project root (a workspace that hoists it to the repository root, or Yarn PnP), resolve the path instead:

```js
import { fileURLToPath } from "node:url";

// in test: { ... }
environment: fileURLToPath(import.meta.resolve("@rsdom/vitest")),
```

To use `environment: "rsdom"` (or a per-file `// @vitest-environment rsdom` comment) instead of a path, install [vitest-environment-rsdom](https://www.npmjs.com/package/vitest-environment-rsdom), the same environment under the name Vitest resolves. All pools are supported, including `vmThreads` and `vmForks`.
