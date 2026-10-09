"use strict";
// A per-document index of the style rules that can apply to elements, used by getComputedStyle.
//
// The original cascade (still used as the fallback) walks every rule of every style sheet for every element and asks
// @asamuzakjp/dom-selector whether its selector matches. That is exact but slow: each check() validates and clones the
// selector AST, wraps the node, etc. This module instead:
//
// - flattens the sheets (default style sheet, document sheets, @import and @media) into one list of entries in cascade
//   order, built once and reused until a style sheet changes (tracked by per-sheet versions),
// - compiles selectors from a conservative, well understood subset of Selectors (type, universal, id, class, plain
//   attribute selectors, the four combinators, :not()/:is()/:where() and a few structural pseudo-classes) into
//   matcher functions,
// - buckets entries by the most selective key of each selector's subject (id, class, attribute name, tag), so most
//   rules are never looked at for a given element.
//
// Anything outside the subset (and any element or document the compiled matchers don't model exactly: XML documents,
// non-HTML elements, namespaced attributes, quirks-mode id/class matching, shadow trees, ...) uses the original
// dom-selector based code path, so the behavior is unchanged.

const Specificity = require("@bramus/specificity").default;
const CSSImportRule = require("../../../../generated/idl/CSSImportRule.js");
const CSSMediaRule = require("../../../../generated/idl/CSSMediaRule.js");
const CSSStyleRule = require("../../../../generated/idl/CSSStyleRule.js");
const csstree = require("./patched-csstree.js");

const HTML_NS = "http://www.w3.org/1999/xhtml";
const DOCUMENT_NODE = 9;
const ELEMENT_NODE = 1;

// Attributes whose values are matched ASCII case-insensitively for HTML elements (mirrors dom-selector's ATTR_VALUE_I).
let attrValueCaseInsensitive = null;
function getAttrValueCaseInsensitive() {
  if (!attrValueCaseInsensitive) {
    attrValueCaseInsensitive = new Set([
      "accept", "accept-charset", "align", "alink", "axis", "bgcolor", "charset", "checked", "clear", "codetype",
      "color", "compact", "declare", "defer", "dir", "direction", "disabled", "enctype", "face", "frame", "hreflang",
      "http-equiv", "lang", "language", "link", "media", "method", "multiple", "nohref", "noresize", "noshade",
      "nowrap", "readonly", "rel", "rev", "rules", "scope", "scrolling", "selected", "shape", "target", "text", "type",
      "valign", "valuetype", "vlink"
    ]);
  }
  return attrValueCaseInsensitive;
}

// ---------------------------------------------------------------------------------------------------------------------
// Selector compilation
// ---------------------------------------------------------------------------------------------------------------------

class Unsupported extends Error {}
const NEVER_MATCHES = { never: true };
const UNSUPPORTED = new Unsupported();

const SAFE_SELECTOR_RE = /^[\w\s\-#.,>+~*()[\]="':^$|]*$/;

// Returns { complexes, exact } or null when the selector list can't be compiled. When `exact` is false, some
// pseudo-classes were compiled as "unknown" (always true), so the compiled matcher is only a necessary condition
// (a prefilter) and matches must be confirmed by dom-selector.
function compileSelectorList(selectorText) {
  if (typeof selectorText !== "string" || selectorText.length === 0 || selectorText.length > 16384 ||
      !SAFE_SELECTOR_RE.test(selectorText)) {
    return null;
  }
  let ast;
  try {
    ast = csstree.parse(selectorText, {
      context: "selectorList",
      onParseError() {
        throw UNSUPPORTED;
      }
    });
  } catch {
    return null;
  }
  if (ast.type !== "SelectorList" || ast.children.isEmpty) {
    return null;
  }
  // When a selector list contains a pseudo-element, dom-selector's check() reports it, and getComputedStyle() (which
  // doesn't support pseudo-elements) then treats the rule as not matching, whatever the rest of the list is.
  for (const selector of ast.children) {
    if (selector.type === "Selector") {
      for (const node of selector.children) {
        if (node.type === "PseudoElementSelector") {
          return NEVER_MATCHES;
        }
      }
    }
  }
  try {
    const state = { exact: true };
    const complexes = [];
    for (const selector of ast.children) {
      complexes.push(compileComplex(selector, state));
    }
    return { complexes, exact: state.exact };
  } catch (e) {
    if (e instanceof Unsupported) {
      return null;
    }
    throw e;
  }
}

// A complex selector compiles to { compounds: [rightmost, ...], combinators: [between compounds[i] and [i+1]] }.
// `state.exact` is cleared when an "unknown" pseudo-class is compiled; `state` is null where unknowns are not allowed
// (inside :not(), whose negation would turn a necessary condition into a sufficient one).
function compileComplex(selector, state) {
  if (selector.type !== "Selector") {
    throw UNSUPPORTED;
  }
  const compounds = [];
  const combinators = [];
  let current = newCompound();
  let currentEmpty = true;
  for (const node of selector.children) {
    if (node.type === "Combinator") {
      if (currentEmpty) {
        throw UNSUPPORTED;
      }
      if (node.name !== " " && node.name !== ">" && node.name !== "+" && node.name !== "~") {
        throw UNSUPPORTED;
      }
      compounds.push(current);
      combinators.push(node.name);
      current = newCompound();
      currentEmpty = true;
      continue;
    }
    addSimple(current, node, state);
    currentEmpty = false;
  }
  if (currentEmpty) {
    throw UNSUPPORTED;
  }
  compounds.push(current);
  compounds.reverse();
  combinators.reverse();
  return { compounds, combinators };
}

// Ids and classes must be valid CSS identifiers (e.g. "#1" or "#-2" are invalid selectors).
const IDENT_RE = /^(?:--|-?[A-Za-z_\u0080-\uffff])[\w\-\u0080-\uffff]*$/u;

function newCompound() {
  return { tag: null, id: null, classes: [], attrs: [], pseudos: [], hasIdOrClass: false };
}

function addSimple(compound, node, state) {
  switch (node.type) {
    case "TypeSelector": {
      if (node.name === "*") {
        return;
      }
      if (node.name.includes("|") || compound.tag !== null) {
        throw UNSUPPORTED;
      }
      compound.tag = node.name.toLowerCase();
      return;
    }
    case "IdSelector": {
      if (!IDENT_RE.test(node.name)) {
        throw UNSUPPORTED;
      }
      if (compound.id !== null && compound.id !== node.name) {
        // Two different ids never match; keep it simple and let the fallback handle it.
        throw UNSUPPORTED;
      }
      compound.id = node.name;
      compound.hasIdOrClass = true;
      return;
    }
    case "ClassSelector": {
      if (!IDENT_RE.test(node.name)) {
        throw UNSUPPORTED;
      }
      compound.classes.push(node.name);
      compound.hasIdOrClass = true;
      return;
    }
    case "AttributeSelector": {
      compound.attrs.push(compileAttribute(node));
      return;
    }
    case "PseudoClassSelector": {
      compound.pseudos.push(compilePseudoClass(node, state));
      return;
    }
    default: {
      // Pseudo-elements, nesting selectors, percentages, etc.
      throw UNSUPPORTED;
    }
  }
}

function compileAttribute(node) {
  let flag = null;
  if (node.flags !== null && node.flags !== undefined) {
    if (!/^[is]$/i.test(node.flags)) {
      throw UNSUPPORTED;
    }
    flag = node.flags.toLowerCase();
  }
  if (node.name.type !== "Identifier" || node.name.name.includes("|")) {
    throw UNSUPPORTED;
  }
  const rawName = node.name.name;
  if (rawName === "lang") {
    // dom-selector special-cases xml:lang.
    throw UNSUPPORTED;
  }
  const name = rawName.toLowerCase();
  let value = null;
  if (node.matcher !== null) {
    if (!node.value) {
      throw UNSUPPORTED;
    }
    if (node.value.type === "String") {
      ({ value } = node.value);
    } else if (node.value.type === "Identifier") {
      value = node.value.name;
    } else {
      throw UNSUPPORTED;
    }
    if (/[\t\n\f\r\\]/.test(value)) {
      throw UNSUPPORTED;
    }
  }
  const caseInsensitive = flag === null ? getAttrValueCaseInsensitive().has(rawName) : flag === "i";
  if (caseInsensitive && value !== null) {
    value = value.toLowerCase();
  }
  return { name, matcher: node.matcher, value, caseInsensitive };
}

const SIMPLE_PSEUDO_CLASSES = new Set([
  "first-child", "last-child", "only-child", "first-of-type", "last-of-type", "only-of-type", "root", "link",
  "any-link",
  // Never match in jsdom.
  "visited", "popover-open", "modal", "autofill"
]);

function compilePseudoClass(node, state) {
  const name = node.name;
  if (SIMPLE_PSEUDO_CLASSES.has(name)) {
    if (node.children !== null) {
      throw UNSUPPORTED;
    }
    return { kind: name };
  }
  if (name === "not" || name === "is" || name === "where") {
    if (!node.children || node.children.size !== 1) {
      throw UNSUPPORTED;
    }
    const list = node.children.first;
    if (list.type !== "SelectorList" || list.children.isEmpty) {
      throw UNSUPPORTED;
    }
    const complexes = [];
    for (const selector of list.children) {
      complexes.push(compileComplex(selector, name === "not" ? null : state));
    }
    return { kind: name, complexes };
  }
  if (state === null || !/^[a-z][a-z-]*$/.test(name)) {
    throw UNSUPPORTED;
  }
  state.exact = false;
  if ((name === "focus" || name === "focus-visible") && node.children === null) {
    // Only ever matches the focused element (for elements outside shadow trees, which is all the fast path handles).
    return { kind: "focused" };
  }
  return { kind: "unknown" };
}

// Collects the subject keys (from the rightmost compound) used to bucket a complex selector.
function subjectKey(complex) {
  const subject = complex.compounds[0];
  if (subject.id !== null) {
    return ["id", subject.id];
  }
  if (subject.classes.length) {
    return ["class", subject.classes[0]];
  }
  for (const attr of subject.attrs) {
    return ["attr", attr.name];
  }
  if (subject.tag !== null) {
    return ["tag", subject.tag];
  }
  return null;
}

function usesIdOrClass(complexes) {
  for (const complex of complexes) {
    for (const compound of complex.compounds) {
      if (compound.hasIdOrClass) {
        return true;
      }
      for (const pseudo of compound.pseudos) {
        if (pseudo.complexes && usesIdOrClass(pseudo.complexes)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------------

// Per-element data used by the compiled matchers. Elements are only matched by the fast path when
// `isFastPathElement` holds, so these are always HTML elements in an HTML document with plain attributes.
function getClassSet(element, ctx) {
  let set = ctx.classSets.get(element);
  if (set === undefined) {
    const value = element.getAttributeNS(null, "class");
    set = value === null ? null : new Set(value.split(/[\t\n\f\r ]+/));
    ctx.classSets.set(element, set);
  }
  return set;
}

function parentElementOf(element) {
  const parent = element.parentNode;
  return parent !== null && parent.nodeType === ELEMENT_NODE ? parent : null;
}

function previousElementOf(element) {
  let sibling = element.previousSibling;
  while (sibling !== null && sibling.nodeType !== ELEMENT_NODE) {
    sibling = sibling.previousSibling;
  }
  return sibling;
}

function nextElementOf(element) {
  let sibling = element.nextSibling;
  while (sibling !== null && sibling.nodeType !== ELEMENT_NODE) {
    sibling = sibling.nextSibling;
  }
  return sibling;
}

function matchAttr(attr, element) {
  const actual = element.getAttributeNS(null, attr.name);
  if (actual === null) {
    return false;
  }
  if (attr.matcher === null) {
    return true;
  }
  const value = attr.caseInsensitive ? actual.toLowerCase() : actual;
  const expected = attr.value;
  switch (attr.matcher) {
    case "=":
      return value === expected;
    case "~=":
      if (expected === "" || /\s/.test(expected)) {
        return false;
      }
      return ` ${value.replace(/[\t\r\n\f]/g, " ")} `.includes(` ${expected} `);
    case "|=":
      return expected !== "" && (value === expected || value.startsWith(`${expected}-`));
    case "^=":
      return expected !== "" && value.startsWith(expected);
    case "$=":
      return expected !== "" && value.endsWith(expected);
    case "*=":
      return expected !== "" && value.includes(expected);
    default:
      return false;
  }
}

function matchCompound(compound, element, ctx) {
  if (compound.tag !== null && element._localName !== compound.tag) {
    return false;
  }
  if (compound.id !== null && element.getAttributeNS(null, "id") !== compound.id) {
    return false;
  }
  if (compound.classes.length) {
    const set = getClassSet(element, ctx);
    if (set === null) {
      return false;
    }
    for (const cls of compound.classes) {
      if (!set.has(cls)) {
        return false;
      }
    }
  }
  for (const attr of compound.attrs) {
    if (!matchAttr(attr, element)) {
      return false;
    }
  }
  for (const pseudo of compound.pseudos) {
    if (!matchPseudo(pseudo, element, ctx)) {
      return false;
    }
  }
  return true;
}

function matchPseudo(pseudo, element, ctx) {
  switch (pseudo.kind) {
    case "first-child":
      return previousElementOf(element) === null;
    case "last-child":
      return nextElementOf(element) === null;
    case "only-child":
      return previousElementOf(element) === null && nextElementOf(element) === null;
    case "first-of-type":
      return !hasSiblingOfType(element, previousElementOf);
    case "last-of-type":
      return !hasSiblingOfType(element, nextElementOf);
    case "only-of-type":
      return !hasSiblingOfType(element, previousElementOf) && !hasSiblingOfType(element, nextElementOf);
    case "link":
    case "any-link":
      return (element._localName === "a" || element._localName === "area") &&
        element.getAttributeNS(null, "href") !== null;
    case "visited":
    case "popover-open":
    case "modal":
    case "autofill":
      return false;
    case "focused":
      if (ctx.activeElement === undefined) {
        ctx.activeElement = element._ownerDocument.activeElement;
      }
      return element === ctx.activeElement;
    case "unknown":
      return true;
    case "root": {
      const parent = element.parentNode;
      return parent !== null && parent.nodeType === DOCUMENT_NODE;
    }
    case "not":
      return !matchAnyComplex(pseudo.complexes, element, ctx);
    case "is":
    case "where":
      return matchAnyComplex(pseudo.complexes, element, ctx);
    default:
      return false;
  }
}

function hasSiblingOfType(element, step) {
  const localName = element._localName;
  const namespace = element._namespaceURI;
  for (let sibling = step(element); sibling !== null; sibling = step(sibling)) {
    if (sibling._localName === localName && sibling._namespaceURI === namespace) {
      return true;
    }
  }
  return false;
}

function matchAnyComplex(complexes, element, ctx) {
  for (const complex of complexes) {
    if (matchComplexAt(complex, 0, element, ctx)) {
      return true;
    }
  }
  return false;
}

function matchComplexAt(complex, index, element, ctx) {
  const { compounds, combinators } = complex;
  if (!matchCompound(compounds[index], element, ctx)) {
    return false;
  }
  if (index === compounds.length - 1) {
    return true;
  }
  const next = index + 1;
  switch (combinators[index]) {
    case ">": {
      const parent = parentElementOf(element);
      return parent !== null && matchComplexAt(complex, next, parent, ctx);
    }
    case " ": {
      for (let ancestor = parentElementOf(element); ancestor !== null; ancestor = parentElementOf(ancestor)) {
        if (matchComplexAt(complex, next, ancestor, ctx)) {
          return true;
        }
      }
      return false;
    }
    case "+": {
      const sibling = previousElementOf(element);
      return sibling !== null && matchComplexAt(complex, next, sibling, ctx);
    }
    case "~": {
      for (let sibling = previousElementOf(element); sibling !== null; sibling = previousElementOf(sibling)) {
        if (matchComplexAt(complex, next, sibling, ctx)) {
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------------------------------

// Entry kinds.
const FAST = 1;
const FALLBACK = 2;
// Compiled as a necessary condition; confirmed with dom-selector.
const PREFILTER = 3;

const compiledCache = new Map();
function compileCached(selectorText) {
  let compiled = compiledCache.get(selectorText);
  if (compiled === undefined) {
    compiled = compileSelectorList(selectorText);
    if (compiledCache.size > 5000) {
      compiledCache.clear();
    }
    compiledCache.set(selectorText, compiled);
  }
  return compiled;
}

function pushBucket(map, key, entry) {
  let list = map.get(key);
  if (list === undefined) {
    list = [];
    map.set(key, list);
  }
  if (list[list.length - 1] !== entry) {
    list.push(entry);
  }
}

class StyleIndex {
  constructor(sheets, quirks) {
    this.quirks = quirks;
    this.entries = [];
    this.byId = new Map();
    this.byClass = new Map();
    this.byAttr = new Map();
    this.byTag = new Map();
    this.universal = [];
    this.fallback = [];
    // [sheet, version] pairs used to validate the index.
    this.sheetVersions = [];
    this.topSheets = sheets.slice();
    this.anyIdOrClass = false;
    for (const sheet of sheets) {
      this.#addSheet(sheet, []);
    }
  }

  isValidFor(sheets) {
    if (sheets.length !== this.topSheets.length) {
      return false;
    }
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i] !== this.topSheets[i]) {
        return false;
      }
    }
    for (const [sheet, version, importRule, importSheet] of this.sheetVersions) {
      if ((sheet._rulesVersion || 0) !== version) {
        return false;
      }
      if (importRule && importRule.styleSheet !== importSheet) {
        return false;
      }
    }
    return true;
  }

  #addSheet(sheet, media) {
    this.sheetVersions.push([sheet, sheet._rulesVersion || 0, null, null]);
    for (const rule of sheet.cssRules._list) {
      if (CSSImportRule.isImpl(rule)) {
        const importSheet = rule.styleSheet;
        this.sheetVersions.push([sheet, sheet._rulesVersion || 0, rule, importSheet]);
        if (importSheet !== null) {
          this.#addSheet(importSheet, [...media, rule.media._list]);
        }
      } else if (CSSMediaRule.isImpl(rule)) {
        const innerMedia = [...media, rule.media._list];
        for (const inner of rule.cssRules._list) {
          this.#addRule(inner, innerMedia, CSSStyleRule.isImpl(inner));
        }
      } else if (CSSStyleRule.isImpl(rule)) {
        this.#addRule(rule, media, true);
      }
    }
  }

  #addRule(rule, media, isStyleRule) {
    const order = this.entries.length;
    const compiled = isStyleRule ? compileCached(rule.selectorText) : null;
    if (compiled === NEVER_MATCHES) {
      return;
    }
    const complexes = compiled ? compiled.complexes : null;
    const entry = {
      order,
      rule,
      media,
      kind: compiled ? (compiled.exact ? FAST : PREFILTER) : FALLBACK,
      complexes,
      specificity: null,
      usesIdOrClass: compiled ? usesIdOrClass(complexes) : false
    };
    this.entries.push(entry);
    if (!compiled) {
      this.fallback.push(entry);
      return;
    }
    if (entry.usesIdOrClass) {
      this.anyIdOrClass = true;
    }
    for (const complex of complexes) {
      const key = subjectKey(complex);
      if (key === null) {
        this.universal.push(entry);
        continue;
      }
      const [type, name] = key;
      if (type === "id") {
        pushBucket(this.byId, this.quirks ? name.toLowerCase() : name, entry);
      } else if (type === "class") {
        pushBucket(this.byClass, this.quirks ? name.toLowerCase() : name, entry);
      } else if (type === "attr") {
        pushBucket(this.byAttr, name, entry);
      } else {
        pushBucket(this.byTag, name, entry);
      }
    }
  }

  // Returns the candidate entries for an element, in cascade order, deduplicated.
  candidates(element, ctx) {
    const result = [];
    const add = list => {
      if (list !== undefined) {
        for (let i = 0; i < list.length; i++) {
          result.push(list[i]);
        }
      }
    };
    add(this.universal);
    add(this.fallback);
    add(this.byTag.get(element._localName));
    if (this.byId.size) {
      const id = element.getAttributeNS(null, "id");
      if (id !== null) {
        add(this.byId.get(this.quirks ? id.toLowerCase() : id));
      }
    }
    if (this.byClass.size) {
      const set = getClassSet(element, ctx);
      if (set !== null) {
        for (const cls of set) {
          add(this.byClass.get(this.quirks ? cls.toLowerCase() : cls));
        }
      }
    }
    if (this.byAttr.size) {
      for (const attr of element._attributeList) {
        add(this.byAttr.get(attr._localName));
      }
    }
    result.sort((a, b) => a.order - b.order);
    // Deduplicate (an entry can be reached through several keys).
    let w = 0;
    for (let r = 0; r < result.length; r++) {
      if (w === 0 || result[w - 1] !== result[r]) {
        result[w++] = result[r];
      }
    }
    result.length = w;
    return result;
  }
}

function getSpecificity(entry) {
  if (entry.specificity === null) {
    entry.specificity = Specificity.max(...Specificity.calculate(entry.rule.selectorText)).value;
  }
  return entry.specificity;
}

// The fast path models HTML elements in HTML documents whose root is the document, without namespaced attributes.
function isFastPathElement(element) {
  if (element._namespaceURI !== HTML_NS) {
    return false;
  }
  const localName = element._localName;
  if (localName !== localName.toLowerCase()) {
    return false;
  }
  const attrs = element._attributeList;
  if (!attrs) {
    return false;
  }
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const name = attr._localName;
    if (attr._namespace !== null || name.includes(":") || name !== name.toLowerCase()) {
      return false;
    }
  }
  return true;
}

function isDocumentRooted(element, document) {
  let node = element;
  for (;;) {
    const parent = node.parentNode;
    if (parent === null) {
      return node === document;
    }
    if (parent.nodeType !== ELEMENT_NODE) {
      return parent === document;
    }
    node = parent;
  }
}

function getStyleIndex(document, sheets) {
  const quirks = document.compatMode === "BackCompat";
  let index = document._styleIndex;
  if (index === undefined || index === null || index.quirks !== quirks || !index.isValidFor(sheets)) {
    index = new StyleIndex(sheets, quirks);
    document._styleIndex = index;
  }
  return index;
}

module.exports = {
  FAST,
  FALLBACK,
  PREFILTER,
  getStyleIndex,
  getSpecificity,
  isFastPathElement,
  isDocumentRooted,
  matchAnyComplex,
  compileSelectorList
};
