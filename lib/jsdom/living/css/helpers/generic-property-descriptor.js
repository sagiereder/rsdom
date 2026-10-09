"use strict";

const parsers = require("./css-values");

// Constants
const { AST_TYPES } = parsers;
const GENERIC_SETTER_CACHE_LIMIT = 1024;

/**
 * Creates a generic property descriptor for a given property. Such descriptors are used whenever we don't have a
 * specific handler in `./properties/*.js`. They perform some basic logic that works as a fallback, and is correct for
 * simple properties, but properties with more complex grammars will need their own handlers.
 *
 * @param {string} property - The canonical CSS property name (e.g. "backdrop-filter", not "backdropFilter").
 * @param {object} opts - The options object.
 * @param {boolean} opts.caseSensitive - True if value is case-sensitive, false otherwise.
 * @param {object} [opts.dimensionTypes={}] - An object containing information about the dimension types used by this
 * property, if any. Keys are a type of dimension, which determines which serializer to use, and values are the
 * information used by the serializer to serialize a parsed value.
 * @param {object} [opts.functionTypes={}] - An object containing information about the function types used by this
 * property, if any. Keys are a type of function, which determines which function to use; values are ignored.
 * @returns {object} The property descriptor object.
 */
function createGenericPropertyDescriptor(property, { caseSensitive, dimensionTypes = {}, functionTypes = {} }) {
  function computeValue(v) {
    if (parsers.hasVarFunc(v)) {
      return v;
    }
    const parsedValue = parsers.parsePropertyValue(property, v, {
      caseSensitive
    });
    if (Array.isArray(parsedValue)) {
      if (parsedValue.length === 1) {
        const {
          angle: angleType,
          dimension: dimensionType,
          length: lengthType,
          number: numberType,
          percentage: percentageType,
          ratio: ratioType
        } = dimensionTypes;
        const { color: colorType, image: imageType, paint: paintType } = functionTypes;
        const [{ name, type, value: itemValue }] = parsedValue;
        switch (type) {
          case AST_TYPES.CALC: {
            return `${name}(${itemValue})`;
          }
          case AST_TYPES.DIMENSION: {
            let val;
            if (dimensionType && lengthType) {
              val = parsers.serializeLength(parsedValue, lengthType);
              if (!val) {
                val = parsers.serializeDimension(parsedValue, dimensionType);
              }
            } else if (lengthType) {
              val = parsers.serializeLength(parsedValue, lengthType);
            } else {
              val = parsers.serializeDimension(parsedValue, dimensionType);
            }
            return val;
          }
          case AST_TYPES.HASH: {
            return parsers.serializeColor(parsedValue);
          }
          case AST_TYPES.NUMBER: {
            let val;
            if (numberType) {
              val = parsers.serializeNumber(parsedValue, numberType);
            } else if (angleType) {
              val = parsers.serializeAngle(parsedValue, angleType);
            } else if (lengthType) {
              val = parsers.serializeLength(parsedValue, lengthType);
            } else if (percentageType) {
              val = parsers.serializePercentage(parsedValue, percentageType);
            } else if (ratioType) {
              val = parsers.serializeRatio(parsedValue, ratioType);
            }
            return val;
          }
          case AST_TYPES.GLOBAL_KEYWORD:
          case AST_TYPES.IDENTIFIER: {
            return name;
          }
          case AST_TYPES.PERCENTAGE: {
            let numericType;
            if (percentageType) {
              numericType = percentageType;
            } else if (dimensionType) {
              numericType = dimensionType;
            } else if (angleType) {
              numericType = angleType;
            } else if (lengthType) {
              numericType = lengthType;
            }
            if (numericType) {
              return parsers.resolveNumericValue(parsedValue, numericType);
            }
            break;
          }
          case AST_TYPES.STRING: {
            return parsers.serializeString(parsedValue);
          }
          case AST_TYPES.URL: {
            return parsers.serializeURL(parsedValue);
          }
          case AST_TYPES.FUNCTION:
          default: {
            if (colorType || paintType) {
              return parsers.serializeColor(parsedValue);
            } else if (imageType) {
              return parsers.serializeGradient(parsedValue);
            }
            return v;
          }
        }
      } else {
        // Set the prepared value for lists containing multiple values.
        return v;
      }
    } else if (typeof parsedValue === "string") {
      return parsedValue;
    }
    return undefined;
  }

  // The value to set only depends on the given value, so memoize it.
  const cache = new Map();

  return {
    set(v, priority = "") {
      v = v.trim();
      let value = cache.get(v);
      if (value === undefined) {
        value = computeValue(v) ?? null;
        if (cache.size >= GENERIC_SETTER_CACHE_LIMIT) {
          cache.clear();
        }
        cache.set(v, value);
      }
      if (value !== null) {
        this._setProperty(property, value, priority);
      }
    },
    get() {
      return this.getPropertyValue(property);
    },
    enumerable: true,
    configurable: true
  };
}

module.exports = {
  createGenericPropertyDescriptor
};
