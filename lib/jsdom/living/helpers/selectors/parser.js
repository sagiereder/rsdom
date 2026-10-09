"use strict";

// A deliberately conservative CSS selector parser for jsdom's fast selector engine (see ./engine.js).
//
// It accepts only a well-understood subset of Selectors Level 4. For anything outside that subset (namespaces, escapes,
// pseudo-elements, unknown or stateful pseudo-classes, :has(), invalid syntax, ...) `parseSelectorList()` returns
// `null` and the caller falls back to @asamuzakjp/dom-selector. That also covers invalid selectors, so the exact
// exceptions (types and messages) keep coming from dom-selector.

// dom-selector rejects selectors longer than this with a RangeError.
const MAX_LENGTH = 2048;

const UNSUPPORTED = { unsupported: true };

function unsupported() {
  throw UNSUPPORTED;
}

// Pseudo-classes without arguments that the engine implements.
const SIMPLE_PSEUDOS = new Set([
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "root",
  "empty",
  "checked",
  "disabled",
  "enabled",
  "link",
  "any-link",
  "scope"
]);

const NTH_PSEUDOS = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);

function isWhitespace(c) {
  // CSS whitespace: space, tab, LF, CR, FF.
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D || c === 0x0C;
}

// Non-ASCII identifiers are left to dom-selector: which code points CSS accepts there changed between spec versions.
function isNameStart(c) {
  return (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c === 0x5F;
}

function isNameChar(c) {
  return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2D;
}

function hasUpperAscii(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5A) {
      return true;
    }
  }
  return false;
}

const WS = "[ \\t\\n\\r\\f]*";
const AN_PLUS_B = new RegExp(
  `^${WS}(?:(odd|even)|([+-]?\\d+)|([+-]?)(\\d*)n(?:${WS}([+-])${WS}(\\d+)|([+-]\\d+))?)${WS}$`,
  "u"
);

function parseAnPlusB(text) {
  const m = AN_PLUS_B.exec(text);
  if (m === null) {
    unsupported();
  }
  let a, b;
  if (m[1] !== undefined) {
    a = 2;
    b = m[1] === "odd" ? 1 : 0;
  } else if (m[2] !== undefined) {
    a = 0;
    b = Number(m[2]);
  } else {
    const digits = m[4];
    a = digits === "" ? 1 : Number(digits);
    if (m[3] === "-") {
      a = -a;
    }
    if (m[5] !== undefined) {
      b = Number(m[6]);
      if (m[5] === "-") {
        b = -b;
      }
    } else if (m[7] !== undefined) {
      b = Number(m[7]);
    } else {
      b = 0;
    }
  }
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || Math.abs(a) > 1e9 || Math.abs(b) > 1e9) {
    unsupported();
  }
  // Normalize -0.
  return { a: a + 0, b: b + 0 };
}

class Parser {
  constructor(input) {
    this.s = input;
    this.i = 0;
    this.usesScope = false;
  }

  peek() {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }

  skipWhitespace() {
    const start = this.i;
    while (this.i < this.s.length && isWhitespace(this.s.charCodeAt(this.i))) {
      this.i++;
    }
    return this.i !== start;
  }

  ident() {
    const { s } = this;
    const start = this.i;
    let c = this.peek();
    if (c === 0x2D) {
      const next = this.i + 1 < s.length ? s.charCodeAt(this.i + 1) : -1;
      if (!(isNameStart(next) || next === 0x2D)) {
        unsupported();
      }
      this.i += 2;
    } else if (isNameStart(c)) {
      this.i++;
    } else {
      unsupported();
    }
    while (this.i < s.length) {
      c = s.charCodeAt(this.i);
      if (!isNameChar(c)) {
        break;
      }
      this.i++;
    }
    return s.slice(start, this.i);
  }

  // A list of complex selectors. When nested (inside :is() etc.), stops before the closing parenthesis.
  parseList(nested) {
    const list = [];
    for (;;) {
      this.skipWhitespace();
      list.push(this.parseComplex());
      this.skipWhitespace();
      const c = this.peek();
      if (c === 0x2C) {
        this.i++;
        continue;
      }
      if (nested ? c === 0x29 : c === -1) {
        return list;
      }
      unsupported();
    }
  }

  // Returns compounds ordered right to left. `parts[k].combinator` relates parts[k] to parts[k + 1], its left
  // neighbor.
  parseComplex() {
    const leftToRight = [this.parseCompound()];
    const combinators = [];
    for (;;) {
      const hadWhitespace = this.skipWhitespace();
      const c = this.peek();
      let combinator;
      if (c === 0x3E || c === 0x2B || c === 0x7E) {
        combinator = String.fromCharCode(c);
        this.i++;
        this.skipWhitespace();
      } else if (hadWhitespace && c !== -1 && c !== 0x2C && c !== 0x29) {
        combinator = " ";
      } else {
        break;
      }
      combinators.push(combinator);
      leftToRight.push(this.parseCompound());
    }
    const parts = [];
    for (let k = leftToRight.length - 1; k >= 0; k--) {
      const compound = leftToRight[k];
      compound.combinator = k > 0 ? combinators[k - 1] : null;
      parts.push(compound);
    }
    return parts;
  }

  parseCompound() {
    const compound = {
      tag: null,
      ids: [],
      classes: [],
      attrs: [],
      pseudos: [],
      combinator: null
    };
    let empty = true;
    const c0 = this.peek();
    if (c0 === 0x2A) {
      this.i++;
      empty = false;
    } else if (isNameStart(c0) || c0 === 0x2D) {
      compound.tag = this.ident();
      empty = false;
    }
    // Namespace prefixes (`ns|tag`, `*|*`, `|tag`).
    if (this.peek() === 0x7C) {
      unsupported();
    }
    for (;;) {
      const c = this.peek();
      if (c === 0x23) {
        this.i++;
        compound.ids.push(this.ident());
      } else if (c === 0x2E) {
        this.i++;
        compound.classes.push(this.ident());
      } else if (c === 0x5B) {
        this.i++;
        compound.attrs.push(this.parseAttribute());
      } else if (c === 0x3A) {
        this.i++;
        compound.pseudos.push(this.parsePseudo());
      } else {
        break;
      }
      empty = false;
    }
    if (empty || this.peek() === 0x7C) {
      unsupported();
    }
    return compound;
  }

  parseAttribute() {
    this.skipWhitespace();
    if (this.peek() === 0x7C || this.peek() === 0x2A) {
      unsupported();
    }
    const name = this.ident();
    // Attribute names with uppercase letters or non-ASCII characters have engine-specific case-folding quirks.
    if (hasUpperAscii(name)) {
      unsupported();
    }
    this.skipWhitespace();
    let c = this.peek();
    if (c === 0x5D) {
      this.i++;
      return { name, op: null, value: null, flag: null };
    }
    let op;
    if (c === 0x3D) {
      op = "=";
      this.i++;
    } else if (c === 0x7E || c === 0x7C || c === 0x5E || c === 0x24 || c === 0x2A) {
      if (this.s.charCodeAt(this.i + 1) !== 0x3D) {
        unsupported();
      }
      op = this.s.slice(this.i, this.i + 2);
      this.i += 2;
    } else {
      unsupported();
    }
    this.skipWhitespace();
    c = this.peek();
    const value = c === 0x22 || c === 0x27 ? this.quotedString(c) : this.ident();
    this.skipWhitespace();
    let flag = null;
    c = this.peek();
    if (c !== 0x5D) {
      const f = this.ident();
      if (f === "i" || f === "I") {
        flag = "i";
      } else if (f === "s" || f === "S") {
        flag = "s";
      } else {
        unsupported();
      }
      this.skipWhitespace();
    }
    if (this.peek() !== 0x5D) {
      unsupported();
    }
    this.i++;
    // dom-selector deviates from the spec for `[attr|=""]`.
    if (op === "|=" && value === "") {
      unsupported();
    }
    return { name, op, value, flag };
  }

  quotedString(quote) {
    const end = this.s.indexOf(String.fromCharCode(quote), this.i + 1);
    if (end === -1) {
      unsupported();
    }
    const value = this.s.slice(this.i + 1, end);
    if (/[\n\r\f]/u.test(value)) {
      unsupported();
    }
    this.i = end + 1;
    return value;
  }

  parsePseudo() {
    if (this.peek() === 0x3A) {
      // Pseudo-elements.
      unsupported();
    }
    const name = this.ident();
    if (hasUpperAscii(name)) {
      unsupported();
    }
    if (this.peek() !== 0x28) {
      if (!SIMPLE_PSEUDOS.has(name)) {
        unsupported();
      }
      if (name === "scope") {
        this.usesScope = true;
      }
      return { name };
    }
    this.i++;
    if (name === "not" || name === "is" || name === "where") {
      const list = this.parseList(true);
      this.i++;
      return { name, list };
    }
    if (NTH_PSEUDOS.has(name)) {
      const end = this.s.indexOf(")", this.i);
      if (end === -1) {
        unsupported();
      }
      const { a, b } = parseAnPlusB(this.s.slice(this.i, end));
      this.i = end + 1;
      return { name, a, b };
    }
    return unsupported();
  }
}

// Returns `{ list, usesScope }` or `null` when the selector must be handled by dom-selector.
exports.parseSelectorList = selector => {
  if (selector.length === 0 || selector.length > MAX_LENGTH) {
    return null;
  }
  // Escapes, comments, and NUL (which CSS replaces) are left to dom-selector.
  if (selector.includes("\\") || selector.includes("/*") || selector.includes("\0")) {
    return null;
  }
  const parser = new Parser(selector);
  try {
    const list = parser.parseList(false);
    return { list, usesScope: parser.usesScope };
  } catch (e) {
    if (e === UNSUPPORTED) {
      return null;
    }
    throw e;
  }
};
