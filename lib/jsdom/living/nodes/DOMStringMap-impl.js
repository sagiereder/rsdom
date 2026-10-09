"use strict";

const idlUtils = require("../../../generated/idl/utils.js");
const { setAttributeValue, removeAttributeByName } = require("../attributes");
const validateAttributeLocalName = require("../helpers/validate-names").attributeLocalName;
const DOMException = require("../../../generated/idl/DOMException");

const dataAttrRe = /^data-([^A-Z]*)$/;

function attrCamelCase(name) {
  return name.replace(/-([a-z])/g, (match, alpha) => alpha.toUpperCase());
}

function attrSnakeCase(name) {
  return name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

// Maps a property name to the local name of the attributes whose name-value pair would have that name, or null if
// no attribute can. Converting the rest of a data-* attribute's name (which has no ASCII upper alphas) to a pair name
// replaces each "-" followed by an ASCII lower alpha with that letter uppercased, so the only rest that can produce
// `name` is `name` with each ASCII upper alpha replaced by "-" and its lowercase; it does if converting it back gives
// `name`.
const attributeNameCache = new Map();
const ATTRIBUTE_NAME_CACHE_LIMIT = 1024;

function attributeNameFor(name) {
  let result = attributeNameCache.get(name);
  if (result === undefined) {
    const rest = attrSnakeCase(name);
    result = attrCamelCase(rest) === name ? `data-${rest}` : null;
    if (attributeNameCache.size >= ATTRIBUTE_NAME_CACHE_LIMIT) {
      attributeNameCache.clear();
    }
    attributeNameCache.set(name, result);
  }
  return result;
}

exports.implementation = class DOMStringMapImpl {
  constructor(globalObject, args, privateData) {
    this._globalObject = globalObject;
    this._element = privateData.element;
  }
  get [idlUtils.supportedPropertyNames]() {
    const result = new Set();
    const attributeList = this._element._attributeList;
    for (let i = 0; i < attributeList.length; i++) {
      const matches = dataAttrRe.exec(attributeList[i]._localName);
      if (matches) {
        result.add(attrCamelCase(matches[1]));
      }
    }
    return result;
  }
  [idlUtils.namedGet](name) {
    const attributeName = attributeNameFor(name);
    if (attributeName === null) {
      return undefined;
    }
    // The first attribute (in any namespace) with that local name gives the first pair with this name.
    const attributeList = this._element._attributeList;
    for (let i = 0; i < attributeList.length; i++) {
      const attr = attributeList[i];
      if (attr._localName === attributeName) {
        return attr._value;
      }
    }
    return undefined;
  }
  // https://html.spec.whatwg.org/multipage/dom.html#dom-domstringmap-setitem
  [idlUtils.namedSetNew](name, value) {
    if (/-[a-z]/.test(name)) {
      throw DOMException.create(this._globalObject, [
        `'${name}' is not a valid property name`,
        "SyntaxError"
      ]);
    }
    name = `data-${attrSnakeCase(name)}`;
    validateAttributeLocalName(this._globalObject, name);
    setAttributeValue(this._element, name, value);
  }
  [idlUtils.namedSetExisting](name, value) {
    this[idlUtils.namedSetNew](name, value);
  }
  [idlUtils.namedDelete](name) {
    name = `data-${attrSnakeCase(name)}`;
    removeAttributeByName(this._element, name);
  }
};
