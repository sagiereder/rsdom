# @rsdom/jest

A [Jest](https://jestjs.io/) test environment backed by rsdom ([@rsdom/core](https://www.npmjs.com/package/@rsdom/core)), a drop-in fork of jsdom with a Rust core. It is a mirror of `jest-environment-jsdom` and accepts the same `testEnvironmentOptions`.

```sh
npm install --save-dev @rsdom/jest
```

```js
// jest.config.js
module.exports = {
  testEnvironment: "@rsdom/jest"
};
```

A per-file `/** @jest-environment @rsdom/jest */` docblock works too. This package depends on `jest-util`, `jest-mock` and `@jest/fake-timers` directly, so it works under pnpm and Yarn PnP. With npm or Yarn's `node_modules` linker you can skip it, install only `@rsdom/core`, and use `testEnvironment: "@rsdom/core/jest"`.
