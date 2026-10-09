# jest-environment-rsdom

A [Jest](https://jestjs.io/) test environment backed by [rsdom](https://www.npmjs.com/package/rsdom), a drop-in fork of jsdom with a Rust core. It is a mirror of `jest-environment-jsdom` and accepts the same `testEnvironmentOptions`.

```sh
npm install --save-dev jest-environment-rsdom
```

```js
// jest.config.js
module.exports = {
  testEnvironment: "rsdom"
};
```

With npm or Yarn's `node_modules` linker you can skip this package, install only `rsdom`, and use `testEnvironment: "rsdom/jest"`.
