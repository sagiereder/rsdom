"use strict";
// Shared helpers for benchmark scenarios.

// Deterministic PRNG so every impl sees identical inputs.
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Creates a fresh DOM via the impl adapter (lib/impls.js createDomFactory). Returns a handle with
// { window, serialize(), close() }; close() may return a promise.
function freshDom(ctx, html = "<!DOCTYPE html><html><head></head><body></body></html>", options = {}) {
  return ctx.createDom(html, options);
}

// Install a DOM window's properties as Node globals (similar to global-jsdom). Re-installable: each call
// overwrites the keys installed by the previous call so a fresh window can be swapped in per iteration.
const originalGlobalKeys = new Set(Object.getOwnPropertyNames(globalThis));
const FORCE_KEYS = ["window", "document", "navigator", "location", "self", "Event", "EventTarget", "CustomEvent",
  "KeyboardEvent", "MouseEvent", "FocusEvent", "InputEvent", "UIEvent"];
let installedKeys = [];

function installGlobals(window) {
  for (const key of installedKeys) {
    delete globalThis[key];
  }
  installedKeys = [];
  const keys = new Set(FORCE_KEYS);
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key.startsWith("_") || originalGlobalKeys.has(key)) {
      continue;
    }
    keys.add(key);
  }
  for (const key of keys) {
    let value;
    try {
      value = key === "window" || key === "self" ? window : window[key];
    } catch {
      continue;
    }
    if (value === undefined) {
      continue;
    }
    try {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, enumerable: false, value });
      installedKeys.push(key);
    } catch {
      // non-configurable Node global; skip
    }
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

// Correctness check for scenario results: throws (failing the run, reported as ERR) when actual !== expected, so a
// fast-but-wrong implementation cannot post a time. `expected` may be a per-impl map { default, [impl]: value } for
// results where an impl knowingly diverges (such scenarios also declare a caveat).
function check(actual, expected, what, impl) {
  const want = expected !== null && typeof expected === "object" ?
    (impl in expected ? expected[impl] : expected.default) :
    expected;
  if (actual !== want) {
    throw new Error(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(want)}${impl ? ` (${impl})` : ""}`);
  }
}

module.exports = { rng, freshDom, installGlobals, check };
