"use strict";
// Instantiates the WebAssembly build of rsdom's Rust addon (src/native/, built for wasm32-wasip1) and returns the same
// exports object the native .node addon has.
//
// The module is built without threads, so it needs neither SharedArrayBuffer nor workers (and so no cross-origin
// isolation in browser-based runtimes such as WebContainers). Node-API is provided by emnapi (@emnapi/core and
// @emnapi/runtime, which must be the version of the emnapi archive the module was linked with), and the few WASI calls
// the Rust standard library makes (clock, random, stderr) by the pure-JS WASI implementation of @tybys/wasm-util, so
// no runtime-specific module (such as node:wasi) is needed. Nothing here is specific to particular exports: every
// #[napi] function in the crate is exported, as from the native addon.
const fs = require("node:fs");
const { instantiateNapiModuleSync } = require("@emnapi/core");
const { asyncWork, tsfn } = require("@emnapi/core/plugins");
const { getDefaultContext } = require("@emnapi/runtime");
const { WASI } = require("@tybys/wasm-util");

// WebAssembly pages are 64 KiB; wasm32 memory can have at most 65536 of them (4 GiB).
const MAX_PAGES = 65536;

function readLEB128(bytes, state) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = bytes[state.pos++];
    result += (byte & 0x7F) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

// The module imports its memory (napi-rs links with --import-memory), and the memory supplied must have at least the
// initial size the module declares, which covers its data and stack. Reads it from the import section.
function importedMemoryLimits(bytes) {
  const state = { pos: 8 }; // magic and version
  while (state.pos < bytes.length) {
    const id = bytes[state.pos++];
    const size = readLEB128(bytes, state);
    const end = state.pos + size;
    if (id === 2) {
      const count = readLEB128(bytes, state);
      for (let i = 0; i < count; i++) {
        skipName(bytes, state); // module name
        skipName(bytes, state); // field name
        const kind = bytes[state.pos++];
        switch (kind) {
          case 0: // function: type index
            readLEB128(bytes, state);
            break;
          case 1: // table: element type, limits
            state.pos++;
            skipLimits(bytes, state);
            break;
          case 2: { // memory: limits
            const flags = bytes[state.pos++];
            const initial = readLEB128(bytes, state);
            const maximum = flags & 1 ? readLEB128(bytes, state) : MAX_PAGES;
            return { initial, maximum, shared: (flags & 2) !== 0 };
          }
          case 3: // global: value type, mutability
            state.pos += 2;
            break;
          case 4: // tag: attribute, type index
            state.pos++;
            readLEB128(bytes, state);
            break;
          default:
            throw new Error(`Unexpected import kind ${kind} in the rsdom WebAssembly module`);
        }
      }
      break;
    }
    state.pos = end;
  }
  throw new Error("The rsdom WebAssembly module does not import its memory");
}

function skipName(bytes, state) {
  const length = readLEB128(bytes, state);
  state.pos += length;
}

function skipLimits(bytes, state) {
  const flags = bytes[state.pos++];
  readLEB128(bytes, state);
  if (flags & 1) {
    readLEB128(bytes, state);
  }
}

function load(wasmFile) {
  const bytes = fs.readFileSync(wasmFile);
  const limits = importedMemoryLimits(bytes);
  if (limits.shared) {
    throw new Error(`${wasmFile} was built for threads; rsdom's loader needs a wasm32-wasip1 (non-threaded) build`);
  }
  const memory = new WebAssembly.Memory({ initial: limits.initial, maximum: limits.maximum });
  const wasi = new WASI({ version: "preview1" });

  const { napiModule } = instantiateNapiModuleSync(new WebAssembly.Module(bytes), {
    context: getDefaultContext(),
    wasi,
    // Without threads, the async work and threadsafe function APIs are implemented in JS by these plugins (the addon
    // does not use them, but napi-rs links them).
    asyncWorkPoolSize: 0,
    plugins: [asyncWork, tsfn],
    overwriteImports(importObject) {
      importObject.env = { ...importObject.env, ...importObject.napi, ...importObject.emnapi, memory };
      return importObject;
    },
    beforeInit({ instance }) {
      // napi-rs registers each #[napi] item with a generated function, which must run before the module's exports
      // are created.
      for (const name of Object.keys(instance.exports)) {
        if (name.startsWith("__napi_register__")) {
          instance.exports[name]();
        }
      }
    }
  });
  return napiModule.exports;
}

module.exports = { load };
