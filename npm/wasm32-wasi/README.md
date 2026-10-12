# @rsdom/core-wasm32-wasi

The WebAssembly (`wasm32-wasip1`) build of rsdom's Rust core, for [@rsdom/core](https://www.npmjs.com/package/@rsdom/core). Don't install it directly: @rsdom/core depends on it, and uses it when no prebuilt native binary is installed for your platform (or when `JSDOM_NATIVE=wasm` is set). It runs without threads, so it needs neither SharedArrayBuffer nor cross-origin isolation.
