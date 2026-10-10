# vitest-environment-rsdom

A [Vitest](https://vitest.dev/) environment backed by rsdom ([@rsdom/core](https://www.npmjs.com/package/@rsdom/core)), a drop-in fork of jsdom with a Rust core. It mirrors Vitest's built-in `jsdom` environment, and its name lets you select it with `environment: "rsdom"`.

```sh
npm install --save-dev vitest-environment-rsdom
```

```js
// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "rsdom",
    // Optional: the same options as Vitest's jsdom environment. `environmentOptions.jsdom` works too.
    environmentOptions: { rsdom: { url: "http://localhost:3000" } }
  }
});
```

The per-file comment works too: `// @vitest-environment rsdom`. All pools are supported, including `vmThreads` and `vmForks`.

It is the same environment as [@rsdom/vitest](https://www.npmjs.com/package/@rsdom/vitest), which has to be given as a path because Vitest only resolves names of the form `vitest-environment-<name>`.
