# vitest-environment-rsdom

A [Vitest](https://vitest.dev/) environment backed by [rsdom](https://www.npmjs.com/package/rsdom), a drop-in fork of jsdom with a Rust core. It is a mirror of Vitest's built-in `jsdom` environment.

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
