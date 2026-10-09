"use strict";
const { findAttributeByName } = require("../../attributes");

// Fast selector matching for querySelector(), querySelectorAll(), matches() and closest(), working directly on impls.
//
// Only the subset of selectors accepted by ./parser.js is handled here. Everything else (and every situation where the
// semantics of @asamuzakjp/dom-selector are subtle, e.g. quirks-mode case-insensitivity, detached roots, custom
// elements) is delegated back to dom-selector, so observable behavior stays identical:
//
// - Each entry point returns `UNHANDLED` when the caller must fall back to dom-selector.
// - During matching, `bail()` aborts the whole operation (it has no side effects) for the same purpose.
//
// The matching semantics deliberately mirror dom-selector's Finder (attribute name/value case handling, :checked,
// :disabled, :empty, ...), not just the specification.

const { HTML_NS, XML_NS } = require("../namespaces");
const { parseSelectorList } = require("./parser");

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;

const UNHANDLED = Symbol("unhandled");
exports.UNHANDLED = UNHANDLED;

const BAIL = { bail: true };
function bail() {
  throw BAIL;
}

// Attribute names whose values dom-selector compares case-insensitively on HTML elements.
const ATTR_VALUE_I = new Set([
  "accept", "accept-charset", "align", "alink", "axis", "bgcolor", "charset", "checked", "clear", "codetype", "color",
  "compact", "declare", "defer", "dir", "direction", "disabled", "enctype", "face", "frame", "hreflang", "http-equiv",
  "lang", "language", "link", "media", "method", "multiple", "nohref", "noresize", "noshade", "nowrap", "readonly",
  "rel", "rev", "rules", "scope", "scrolling", "selected", "shape", "target", "text", "type", "valign", "valuetype",
  "vlink"
]);

const DISABLEABLE = new Set(["button", "input", "select", "textarea", "fieldset", "optgroup", "option"]);

// ---------------------------------------------------------------------------------------------------------------------
// Compilation and caching

const CACHE_LIMIT = 1024;
const cache = new Map();

function compileCompound(c) {
  const out = {
    tag: c.tag === null ? null : c.tag,
    tagLower: c.tag === null ? null : c.tag.toLowerCase(),
    ids: c.ids,
    classes: c.classes,
    attrs: c.attrs.map(compileAttr),
    pseudos: c.pseudos.map(compilePseudo),
    combinator: c.combinator,
    // The compound standing for the subject of an enclosing :has().
    anchor: c.anchor === true
  };
  out.simple = !out.anchor && out.ids.length === 0 && out.classes.length === 0 && out.attrs.length === 0 &&
    out.pseudos.length === 0;
  return out;
}

function compileAttr(a) {
  const ci = a.flag === "i";
  const value = a.value === null ? null : a.value;
  return {
    name: a.name,
    op: a.op,
    flag: a.flag,
    value,
    // dom-selector lowercases the expected value when matching case-insensitively.
    valueLower: value === null ? null : value.toLowerCase(),
    explicitCI: ci,
    // Case-insensitive on HTML elements without an explicit flag.
    implicitCI: a.flag === null && ATTR_VALUE_I.has(a.name),
    tildeTarget: a.op === "~=" && value !== null && !/\s/u.test(value) ? ` ${value} ` : null,
    tildeTargetLower: a.op === "~=" && value !== null && !/\s/u.test(value) ? ` ${value.toLowerCase()} ` : null
  };
}

function compilePseudo(p) {
  if (p.name === "has") {
    return { name: p.name, list: p.list.map(compileRelative) };
  }
  if (p.list !== undefined) {
    return { name: p.name, list: p.list.map(compileComplex) };
  }
  if (p.a !== undefined) {
    return {
      name: p.name,
      a: p.a,
      b: p.b,
      isLast: p.name === "nth-last-child" || p.name === "nth-last-of-type",
      ofType: p.name === "nth-of-type" || p.name === "nth-last-of-type"
    };
  }
  return { name: p.name };
}

function compileComplex(parts) {
  return parts.map(compileCompound);
}

function compileRelative(parts) {
  const compiled = compileComplex(parts);
  // Where the matches can be relative to the :has() subject: among its descendants for a leading descendant or child
  // combinator, otherwise among its following siblings (and, unless all combinators are sibling ones, their
  // descendants).
  const lead = compiled[compiled.length - 2].combinator;
  let siblingsOnly = true;
  for (let j = 0; j < compiled.length - 1; j++) {
    const comb = compiled[j].combinator;
    if (comb === " " || comb === ">") {
      siblingsOnly = false;
    }
  }
  return {
    parts: compiled,
    inSubtree: lead === " " || lead === ">",
    childrenOnly: lead === ">" && compiled.length === 2,
    siblingsOnly,
    nextSiblingOnly: lead === "+" && compiled.length === 2
  };
}

// For a complex selector, finds an ID that every match must be a descendant of (or be). Returns `{ id, self }` where
// `self` is true when the ID is on the subject compound itself.
function findAnchor(parts) {
  if (parts[0].ids.length > 0) {
    return { id: parts[0].ids[0], self: true };
  }
  for (let j = 0; j < parts.length - 1; j++) {
    const comb = parts[j].combinator;
    if (comb !== " " && comb !== ">") {
      return null;
    }
    if (parts[j + 1].ids.length > 0) {
      return { id: parts[j + 1].ids[0], self: false };
    }
  }
  return null;
}

function compile(selector) {
  let compiled = cache.get(selector);
  if (compiled !== undefined) {
    return compiled;
  }
  const parsed = parseSelectorList(selector);
  if (parsed === null) {
    compiled = null;
  } else {
    const list = parsed.list.map(compileComplex);
    compiled = {
      list,
      usesScope: parsed.usesScope,
      anchor: list.length === 1 ? findAnchor(list[0]) : null
    };
  }
  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(selector, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-operation state. Matching never runs author code, so this cannot be re-entered.

let gIsHTMLDoc = false;
let gQuirks = false;
let gDocument = null;
// The :scope element, or null when :scope means the document element.
let gScope = null;
// The subject of the :has() being evaluated (:has() cannot nest).
let gHasAnchor = null;

function isQuirks(doc) {
  if (doc._parsingMode === "xml") {
    return false;
  }
  for (let child = firstChildOf(doc); child !== null; child = nextSiblingOf(child)) {
    if (child.nodeType === 10) {
      return false;
    }
  }
  return true;
}

function setUp(doc) {
  gDocument = doc;
  gIsHTMLDoc = doc.contentType === "text/html";
  gQuirks = isQuirks(doc);
}

// ---------------------------------------------------------------------------------------------------------------------
// Element helpers

// Tree links are read directly (see ../dom-tree.js) rather than through the polymorphic Node getters.
function parentNodeOf(n) {
  const l = n._links;
  return l === null ? null : l.parent;
}

function firstChildOf(n) {
  const l = n._links;
  return l === null ? null : l.firstChild;
}

function nextSiblingOf(n) {
  const l = n._links;
  return l === null ? null : l.nextSibling;
}

function previousSiblingOf(n) {
  const l = n._links;
  return l === null ? null : l.previousSibling;
}

function isHTMLElement(el) {
  if (!gIsHTMLDoc) {
    return false;
  }
  const ns = el._namespaceURI;
  return ns === HTML_NS || ns === null;
}

function attrValueNS0(el, localName) {
  const list = el._attributeList;
  for (let i = 0; i < list.length; i++) {
    const attr = list[i];
    if (attr._localName === localName && attr._namespace === null) {
      return attr._value;
    }
  }
  return null;
}

function hasQualifiedAttr(el, name) {
  return findAttributeByName(el, name) !== null;
}

function parentElement(el) {
  const p = parentNodeOf(el);
  return p !== null && p.nodeType === ELEMENT_NODE ? p : null;
}

function previousElementSibling(el) {
  for (let n = previousSiblingOf(el); n !== null; n = previousSiblingOf(n)) {
    if (n.nodeType === ELEMENT_NODE) {
      return n;
    }
  }
  return null;
}

function nextElementSibling(el) {
  for (let n = nextSiblingOf(el); n !== null; n = nextSiblingOf(n)) {
    if (n.nodeType === ELEMENT_NODE) {
      return n;
    }
  }
  return null;
}

function firstElementChild(node) {
  for (let n = firstChildOf(node); n !== null; n = nextSiblingOf(n)) {
    if (n.nodeType === ELEMENT_NODE) {
      return n;
    }
  }
  return null;
}

function isAsciiWhitespace(c) {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0C || c === 0x0D;
}

// Whether `token` appears in `str` as an ASCII-whitespace-delimited token (DOMTokenList semantics).
function hasToken(str, token) {
  const tlen = token.length;
  let from = 0;
  for (;;) {
    const i = str.indexOf(token, from);
    if (i === -1) {
      return false;
    }
    const end = i + tlen;
    if ((i === 0 || isAsciiWhitespace(str.charCodeAt(i - 1))) &&
        (end === str.length || isAsciiWhitespace(str.charCodeAt(end)))) {
      return true;
    }
    from = i + 1;
  }
}

function asciiLowercase(s) {
  return s.replace(/[A-Z]/gu, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
}

function hasTokenAsciiCI(str, token) {
  return hasToken(asciiLowercase(str), asciiLowercase(token));
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

function matchTag(c, el) {
  const localName = el._localName;
  if (localName === c.tag) {
    // For HTML elements this is dom-selector's fast path; for others it is the exact comparison.
    return true;
  }
  if (isHTMLElement(el) && localName === c.tagLower) {
    return true;
  }
  if (localName.includes(":")) {
    bail();
  }
  return false;
}

function matchId(id, el) {
  const value = attrValueNS0(el, "id");
  if (value === id) {
    return true;
  }
  if (gQuirks && value !== null && asciiLowercase(value) === asciiLowercase(id)) {
    bail();
  }
  return false;
}

function matchClass(name, el) {
  const value = attrValueNS0(el, "class");
  if (value === null) {
    return false;
  }
  if (hasToken(value, name)) {
    return true;
  }
  if (gQuirks && hasTokenAsciiCI(value, name)) {
    bail();
  }
  return false;
}

function stripLeadingColon(s) {
  return s.charCodeAt(0) === 0x3A ? s.slice(1) : s;
}

function matchAttr(a, el) {
  const list = el._attributeList;
  if (list.length === 0) {
    return false;
  }
  const isHTML = isHTMLElement(el);
  const { name } = a;

  if (a.op === null && a.flag === null) {
    // Presence test.
    if (name === "lang") {
      for (let i = 0; i < list.length; i++) {
        if (list[i]._namespace === XML_NS && list[i]._localName === "lang") {
          // dom-selector's two matchers disagree here.
          bail();
        }
      }
    }
    if (hasQualifiedAttr(el, name)) {
      return true;
    }
    for (let i = 0; i < list.length; i++) {
      let itemName = list[i]._qualifiedName;
      if (isHTML) {
        itemName = itemName.toLowerCase();
      }
      const colon = itemName.indexOf(":");
      if (colon !== -1) {
        if (stripLeadingColon(itemName.substring(colon + 1)) === name) {
          return true;
        }
      } else if (itemName === name) {
        return true;
      }
    }
    return false;
  }

  const ci = a.explicitCI || (isHTML && a.implicitCI);
  // The selector's attribute name is always lowercase (see the parser), so dom-selector's lowercasing is a no-op.
  for (let i = 0; i < list.length; i++) {
    const attr = list[i];
    const origName = attr._qualifiedName;
    const colon = origName.indexOf(":");
    if ((attr._namespace === XML_NS && attr._localName === "lang") ||
        (colon !== -1 && origName.substring(0, colon) === "xml" &&
         stripLeadingColon(origName.substring(colon + 1)) === "lang")) {
      if (name === "lang") {
        // dom-selector's two matchers disagree here.
        bail();
      }
      continue;
    }
    let isMatch = origName === name || (ci && origName.toLowerCase() === name);
    if (!isMatch && colon !== -1) {
      const local = stripLeadingColon(origName.substring(colon + 1));
      isMatch = local === name || (ci && local.toLowerCase() === name);
    }
    if (!isMatch) {
      continue;
    }
    if (matchAttrValue(a, ci, ci ? attr._value.toLowerCase() : attr._value)) {
      return true;
    }
  }
  return false;
}

function matchAttrValue(a, ci, value) {
  const expected = ci ? a.valueLower : a.value;
  switch (a.op) {
    case null:
      return true;
    case "=":
      return value === expected;
    case "~=": {
      const target = ci ? a.tildeTargetLower : a.tildeTarget;
      if (target === null || expected === "") {
        return false;
      }
      return ` ${value.replace(/[\t\r\n\f]/gu, " ")} `.includes(target);
    }
    case "|=":
      return expected !== "" && (value === expected || value.startsWith(`${expected}-`));
    case "^=":
      return expected !== "" && value.startsWith(expected);
    case "$=":
      return expected !== "" && value.endsWith(expected);
    case "*=":
      return expected !== "" && value.includes(expected);
  }
  return false;
}

function isCustomElementCandidate(el) {
  return el._localName.includes("-") || attrValueNS0(el, "is") !== null || hasQualifiedAttr(el, "is");
}

function isDisabled(el) {
  // Mirrors dom-selector: only the "disabled" attribute (by qualified name or reflected) and simple ancestor rules.
  const localName = el._localName;
  if (hasQualifiedAttr(el, "disabled")) {
    return true;
  }
  if (localName === "option") {
    const parent = parentNodeOf(el);
    return parent !== null && parent._localName === "optgroup" && hasQualifiedAttr(parent, "disabled");
  }
  if (localName === "optgroup") {
    return false;
  }
  for (let current = parentNodeOf(el); current !== null; current = parentNodeOf(current)) {
    if (current.nodeType === ELEMENT_NODE && current._localName === "fieldset" &&
        hasQualifiedAttr(current, "disabled")) {
      let legend = null;
      for (let child = firstElementChild(current); child !== null; child = nextElementSibling(child)) {
        if (child._localName === "legend") {
          legend = child;
          break;
        }
      }
      if (legend === null || !isInclusiveAncestor(legend, el)) {
        return true;
      }
    }
  }
  return false;
}

function isInclusiveAncestor(ancestor, node) {
  for (let n = node; n !== null; n = parentNodeOf(n)) {
    if (n === ancestor) {
      return true;
    }
  }
  return false;
}

// Sibling walks longer than this switch to a per-operation index of the parent's children, so that queries like
// `tr:nth-child(odd)` over thousands of siblings stay linear.
const SIBLING_WALK_LIMIT = 32;
let gNthCache = null;

function parentIndex(parent) {
  if (gNthCache === null) {
    gNthCache = new Map();
  }
  let entry = gNthCache.get(parent);
  if (entry === undefined) {
    const index = new Map();
    let count = 0;
    for (let n = firstChildOf(parent); n !== null; n = nextSiblingOf(n)) {
      if (n.nodeType === ELEMENT_NODE) {
        index.set(n, count++);
      }
    }
    entry = { index, count, typeIndex: null, typeCount: null };
    gNthCache.set(parent, entry);
  }
  return entry;
}

function typeKey(el) {
  return el._namespaceURI === null ? `${el._localName}|` : `${el._localName}|${el._namespaceURI}`;
}

function cachedPosition(el, ofType, isLast) {
  const entry = parentIndex(parentNodeOf(el));
  if (!ofType) {
    const i = entry.index.get(el);
    return isLast ? entry.count - i : i + 1;
  }
  if (entry.typeIndex === null) {
    const typeIndex = new Map();
    const typeCount = new Map();
    for (const child of entry.index.keys()) {
      const key = typeKey(child);
      const pos = (typeCount.get(key) || 0) + 1;
      typeCount.set(key, pos);
      typeIndex.set(child, pos);
    }
    entry.typeIndex = typeIndex;
    entry.typeCount = typeCount;
  }
  const pos = entry.typeIndex.get(el);
  return isLast ? entry.typeCount.get(typeKey(el)) - pos + 1 : pos;
}

// 1-based position of `el` among its element siblings (of the same type if `ofType`), counted from the end if
// `isLast`. The caller has checked that `el` has a parent.
function nthPosition(el, ofType, isLast) {
  const localName = el._localName;
  const ns = el._namespaceURI;
  let pos = 0;
  let steps = 0;
  for (let n = el; n !== null; n = isLast ? nextSiblingOf(n) : previousSiblingOf(n)) {
    if (++steps > SIBLING_WALK_LIMIT) {
      return cachedPosition(el, ofType, isLast);
    }
    if (n.nodeType === ELEMENT_NODE && (!ofType || (n._localName === localName && n._namespaceURI === ns))) {
      pos++;
    }
  }
  return pos;
}

function matchNth(p, el) {
  if (parentNodeOf(el) === null) {
    bail();
  }
  const pos = nthPosition(el, p.ofType, p.isLast);
  const { a, b } = p;
  if (a === 0) {
    return pos === b;
  }
  const diff = pos - b;
  if (diff % a !== 0) {
    return false;
  }
  return a > 0 ? diff >= 0 : diff <= 0;
}

function matchPseudo(p, el) {
  switch (p.name) {
    case "not":
      return !matchesList(p.list, el);
    case "is":
    case "where":
      return matchesList(p.list, el);
    case "nth-child":
    case "nth-last-child":
    case "nth-of-type":
    case "nth-last-of-type":
      return matchNth(p, el);
    case "first-child":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return previousElementSibling(el) === null;
    case "last-child":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return nextElementSibling(el) === null;
    case "only-child":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return previousElementSibling(el) === null && nextElementSibling(el) === null;
    case "first-of-type":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return nthPosition(el, true, false) === 1;
    case "last-of-type":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return nthPosition(el, true, true) === 1;
    case "only-of-type":
      if (parentNodeOf(el) === null) {
        bail();
      }
      return nthPosition(el, true, false) === 1 && nthPosition(el, true, true) === 1;
    case "root":
      return el === gDocument.documentElement;
    case "scope":
      return gScope !== null ? el === gScope : el === gDocument.documentElement;
    case "empty":
      for (let n = firstChildOf(el); n !== null; n = nextSiblingOf(n)) {
        if (n.nodeType === ELEMENT_NODE || n.nodeType === TEXT_NODE) {
          return false;
        }
      }
      return true;
    case "link":
    case "any-link": {
      const localName = el._localName;
      return (localName === "a" || localName === "area") && hasQualifiedAttr(el, "href");
    }
    case "checked": {
      const localName = el._localName;
      if (localName === "option") {
        return Boolean(el.selected);
      }
      if (localName === "input") {
        if (!el.checked) {
          return false;
        }
        const type = attrValueOrQualified(el, "type");
        if (type === "checkbox" || type === "radio") {
          return true;
        }
        if (type !== null && (type.toLowerCase() === "checkbox" || type.toLowerCase() === "radio")) {
          bail();
        }
        return false;
      }
      return false;
    }
    case "has": {
      gHasAnchor = el;
      let result = false;
      for (let i = 0; i < p.list.length && !result; i++) {
        result = matchRelative(p.list[i], el);
      }
      gHasAnchor = null;
      return result;
    }
    case "disabled":
    case "enabled": {
      if (!DISABLEABLE.has(el._localName)) {
        if (isCustomElementCandidate(el)) {
          bail();
        }
        return false;
      }
      return isDisabled(el) === (p.name === "disabled");
    }
  }
  return bail();
}

// Whether some element matches the relative selector `rel` anchored at `el` (gHasAnchor).
function matchRelative(rel, el) {
  const { parts } = rel;
  if (rel.inSubtree) {
    if (rel.childrenOnly) {
      for (let n = firstChildOf(el); n !== null; n = nextSiblingOf(n)) {
        if (n.nodeType === ELEMENT_NODE && matchFrom(parts, 0, n)) {
          return true;
        }
      }
      return false;
    }
    for (let n = firstChildOf(el); n !== null; n = nextInTree(n, el)) {
      if (n.nodeType === ELEMENT_NODE && matchFrom(parts, 0, n)) {
        return true;
      }
    }
    return false;
  }
  for (let s = nextElementSibling(el); s !== null; s = nextElementSibling(s)) {
    if (matchFrom(parts, 0, s)) {
      return true;
    }
    if (rel.nextSiblingOnly) {
      return false;
    }
    if (!rel.siblingsOnly) {
      for (let n = firstChildOf(s); n !== null; n = nextInTree(n, s)) {
        if (n.nodeType === ELEMENT_NODE && matchFrom(parts, 0, n)) {
          return true;
        }
      }
    }
  }
  return false;
}

// getAttribute(name) semantics for a lowercase name: the first attribute whose qualified name matches.
function attrValueOrQualified(el, name) {
  const attr = findAttributeByName(el, name);
  return attr === null ? null : attr._value;
}

function matchCompound(c, el) {
  if (c.anchor) {
    return el === gHasAnchor;
  }
  if (c.tag !== null && !matchTag(c, el)) {
    return false;
  }
  if (c.simple) {
    return true;
  }
  const { ids, classes, attrs, pseudos } = c;
  for (let i = 0; i < ids.length; i++) {
    if (!matchId(ids[i], el)) {
      return false;
    }
  }
  for (let i = 0; i < classes.length; i++) {
    if (!matchClass(classes[i], el)) {
      return false;
    }
  }
  for (let i = 0; i < attrs.length; i++) {
    if (!matchAttr(attrs[i], el)) {
      return false;
    }
  }
  for (let i = 0; i < pseudos.length; i++) {
    if (!matchPseudo(pseudos[i], el)) {
      return false;
    }
  }
  return true;
}

// Whether `el` matches parts[j..] (parts are ordered right to left).
function matchFrom(parts, j, el) {
  if (!matchCompound(parts[j], el)) {
    return false;
  }
  if (j === parts.length - 1) {
    return true;
  }
  const next = j + 1;
  switch (parts[j].combinator) {
    case ">": {
      const p = parentElement(el);
      return p !== null && matchFrom(parts, next, p);
    }
    case " ": {
      for (let p = parentElement(el); p !== null; p = parentElement(p)) {
        if (matchFrom(parts, next, p)) {
          return true;
        }
      }
      return false;
    }
    case "+": {
      const s = previousElementSibling(el);
      return s !== null && matchFrom(parts, next, s);
    }
    case "~": {
      for (let s = previousElementSibling(el); s !== null; s = previousElementSibling(s)) {
        if (matchFrom(parts, next, s)) {
          return true;
        }
      }
      return false;
    }
  }
  return bail();
}

function matchesList(list, el) {
  for (let i = 0; i < list.length; i++) {
    if (matchFrom(list[i], 0, el)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Traversal helpers

// The next node after `node` in tree order, staying within `root`'s subtree.
function nextInTree(node, root) {
  const first = firstChildOf(node);
  if (first !== null) {
    return first;
  }
  for (let n = node; n !== root; n = parentNodeOf(n)) {
    const sibling = nextSiblingOf(n);
    if (sibling !== null) {
      return sibling;
    }
  }
  return null;
}

// Collects matching descendants of `root` (exclusive) in tree order; stops at the first one if `first` is true.
function collect(list, root, first, out) {
  if (list.length === 1) {
    const parts = list[0];
    for (let n = firstChildOf(root); n !== null; n = nextInTree(n, root)) {
      if (n.nodeType === ELEMENT_NODE && matchFrom(parts, 0, n)) {
        out.push(n);
        if (first) {
          return;
        }
      }
    }
    return;
  }
  for (let n = firstChildOf(root); n !== null; n = nextInTree(n, root)) {
    if (n.nodeType === ELEMENT_NODE && matchesList(list, n)) {
      out.push(n);
      if (first) {
        return;
      }
    }
  }
}

// When the (single) complex selector has an ID anchor that is unique in the document, the matches must lie within
// that element's subtree. Returns the element to search under (exclusive or inclusive per `inclusive`), `null` when
// nothing can match, or `undefined` when the anchor can't be used.
function anchorSearch(compiled, root, first, out) {
  const { anchor } = compiled;
  const doc = gDocument;
  if (anchor === null || gQuirks || (root !== doc && !root._isInDocumentTree)) {
    return false;
  }
  const entry = doc._byIdCache._map.get(anchor.id);
  if (entry === undefined) {
    // No element in the document has this ID.
    return true;
  }
  if (entry.count !== 1) {
    return false;
  }
  const anchorEl = doc._byIdCache.get(anchor.id);
  if (anchorEl === null) {
    return true;
  }
  const parts = compiled.list[0];
  if (anchor.self) {
    // The only candidate is the anchor element itself.
    if (anchorEl !== root && isInclusiveAncestor(root, anchorEl) && matchFrom(parts, 0, anchorEl)) {
      out.push(anchorEl);
    }
    return true;
  }
  if (anchorEl === root || isInclusiveAncestor(anchorEl, root)) {
    // The anchor contains the whole search root: no narrowing possible.
    return false;
  }
  if (!isInclusiveAncestor(root, anchorEl)) {
    return true;
  }
  searchUnder(compiled.list, anchorEl, first, out);
  return true;
}

// Returns a live HTMLCollection impl that is a superset of the elements matching compound `c` under `root`, or null.
// For querySelector (`first`), building a collection would defeat the early exit, so only an already-memoized,
// up-to-date collection is used.
function seedFor(root, c, first) {
  const memo = root._getMemoizedQueries();
  let coll;
  if (c.classes.length > 0) {
    const name = c.classes[0];
    if (first) {
      coll = memo.collectionsByClassNames?.get(name);
    } else {
      coll = root.getElementsByClassName(name);
    }
  } else if (c.tag !== null && c.tag === c.tagLower) {
    if (first) {
      coll = memo.collectionsByNamespaceAndLocalName?.get("*")?.get(c.tag);
    } else {
      coll = root.getElementsByTagNameNS("*", c.tag);
    }
  }
  if (coll === undefined || (first && coll._version < root._version)) {
    return null;
  }
  coll._update();
  return coll._list;
}

function searchUnder(list, root, first, out) {
  if (list.length === 1) {
    const parts = list[0];
    const seed = seedFor(root, parts[0], first);
    if (seed !== null) {
      const n = seed.length;
      for (let i = 0; i < n; i++) {
        const el = seed[i];
        if (matchFrom(parts, 0, el)) {
          out.push(el);
          if (first) {
            return;
          }
        }
      }
      return;
    }
  }
  collect(list, root, first, out);
}

function documentOf(node) {
  return node.nodeType === DOCUMENT_NODE ? node : node._ownerDocument;
}

function run(fn) {
  try {
    return fn();
  } catch (e) {
    if (e === BAIL) {
      return UNHANDLED;
    }
    throw e;
  } finally {
    gDocument = null;
    gScope = null;
    gNthCache = null;
    gHasAnchor = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry points. Each returns UNHANDLED when dom-selector must be used instead.

function prepareQuery(selector, root) {
  const compiled = compile(selector);
  if (compiled === null) {
    return null;
  }
  if (compiled.usesScope) {
    if (root.nodeType === ELEMENT_NODE) {
      gScope = root;
    } else if (root.nodeType !== DOCUMENT_NODE) {
      return null;
    }
  }
  setUp(documentOf(root));
  return compiled;
}

exports.querySelectorAll = (selector, root) => {
  const compiled = prepareQuery(selector, root);
  if (compiled === null) {
    gScope = null;
    return UNHANDLED;
  }
  return run(() => {
    const out = [];
    if (!anchorSearch(compiled, root, false, out)) {
      searchUnder(compiled.list, root, false, out);
    }
    return out;
  });
};

exports.querySelector = (selector, root) => {
  const compiled = prepareQuery(selector, root);
  if (compiled === null) {
    gScope = null;
    return UNHANDLED;
  }
  return run(() => {
    const out = [];
    if (!anchorSearch(compiled, root, true, out)) {
      searchUnder(compiled.list, root, true, out);
    }
    return out.length === 0 ? null : out[0];
  });
};

exports.matches = (selector, el) => {
  const compiled = compile(selector);
  if (compiled === null || compiled.usesScope) {
    return UNHANDLED;
  }
  setUp(el._ownerDocument);
  return run(() => matchesList(compiled.list, el));
};

exports.closest = (selector, el) => {
  const compiled = compile(selector);
  if (compiled === null || compiled.usesScope) {
    return UNHANDLED;
  }
  setUp(el._ownerDocument);
  return run(() => {
    for (let n = el; n !== null; n = parentElement(n)) {
      if (matchesList(compiled.list, n)) {
        return n;
      }
    }
    return null;
  });
};

// Exposed for tests.
exports._compile = compile;
