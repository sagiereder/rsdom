"use strict";

/**
 * Define a set of properties on an object, by copying the property descriptors
 * from the original object.
 *
 * - `object` {Object} the target object
 * - `properties` {Object} the source from which to copy property descriptors
 */
exports.define = function define(object, properties) {
  for (const name of Object.getOwnPropertyNames(properties)) {
    const propDesc = Object.getOwnPropertyDescriptor(properties, name);
    Object.defineProperty(object, name, propDesc);
  }
};

exports.mixin = (target, source) => {
  const keys = Reflect.ownKeys(source);
  for (let i = 0; i < keys.length; ++i) {
    if (keys[i] in target) {
      continue;
    }

    Object.defineProperty(target, keys[i], Object.getOwnPropertyDescriptor(source, keys[i]));
  }
};

// Puts per-instance field defaults on a class prototype as writable, non-enumerable data properties. An instance gets
// an own property the first time it writes the field. Use this for fields that most instances never write, and only
// with primitive defaults: constructors run for many classes, so each field they store is a megamorphic,
// map-transitioning store, and fewer of them make object creation cheaper.
exports.defineFieldDefaults = (proto, defaults) => {
  for (const key of Object.keys(defaults)) {
    Object.defineProperty(proto, key, { value: defaults[key], writable: true, enumerable: false, configurable: true });
  }
};

try {
  exports.Canvas = require("canvas");
} catch {
  exports.Canvas = null;
}
