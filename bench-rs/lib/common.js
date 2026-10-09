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

function freshDom(JSDOM, html = "<!DOCTYPE html><html><head></head><body></body></html>", options = {}) {
  return new JSDOM(html, options);
}

// Install a JSDOM window's properties as Node globals (similar to global-jsdom). Re-installable: each call
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

module.exports = { rng, freshDom, installGlobals };
