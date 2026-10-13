"use strict";
// A seeded generator of malformed and well-formed HTML, built to reach the parts of the HTML parsing algorithm where
// parsers tend to disagree, and where source locations are subtle: the adoption agency algorithm, foster parenting and
// table text, foreign content (and leaving it), templates, select, implied and stray end tags, raw text and RCDATA
// elements, character references, comments and doctypes of every kind, newline normalization, astral characters,
// NULs, duplicate and namespaced attributes, and end of input in every tokenizer state.

// mulberry32: a small, fast PRNG; the same seed always gives the same corpus.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS = [
  "html", "head", "body", "p", "div", "span", "a", "b", "i", "em", "strong", "u", "s", "nobr", "big", "small", "font",
  "code", "tt", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "select", "option",
  "optgroup", "hr", "form", "input", "button", "label", "fieldset", "legend", "textarea", "title", "style", "script",
  "noscript", "template", "svg", "math", "foreignObject", "foreignobject", "desc", "mi", "mo", "mn", "ms", "mtext",
  "annotation-xml", "malignmark", "mglyph", "li", "ul", "ol", "dl", "dt", "dd", "h1", "h2", "h3", "pre", "listing",
  "xmp", "iframe", "noembed", "noframes", "frameset", "frame", "img", "image", "br", "area", "base", "link", "meta",
  "object", "applet", "marquee", "ruby", "rb", "rt", "rp", "rtc", "search", "hgroup", "address", "main", "menu",
  "keygen", "wbr", "embed", "param", "source", "track", "path", "circle", "g", "clipPath", "clippath", "linearGradient",
  "x-custom", "sarcasm", "plaintext", "center", "dialog", "details", "summary", "figure", "article", "section"
];
const COMMON_TAGS = [
  "p", "div", "span", "a", "b", "i", "table", "tr", "td", "select", "option", "svg", "math", "template", "li", "ul",
  "form", "body", "html", "head", "title", "textarea", "pre", "script", "style", "foreignObject", "nobr", "em",
  "button", "tbody", "caption", "frameset", "br", "font"
];
const ATTR_NAMES = [
  "id", "class", "href", "title", "style", "type", "value", "name", "src", "data-x", "ID", "Class", "xlink:href",
  "xml:lang", "xmlns", "xmlns:xlink", "xlink:title", "definitionurl", "definitionURL", "viewbox", "viewBox",
  "encoding", "color", "face", "size", "action", "selected", "checked", "a", "b", "x:y", "\"q", "'q", "<a", "=e",
  "x=y"
];
const ATTR_VALUES = [
  "", "x", "a b", "text/html", "application/xhtml+xml", "TEXT/HTML", "hidden", "&amp;", "&lt", "&notin;", "&noti",
  "&ampx", "&am", "&#x41;", "&#0;", "&#128;", "&#xD800;", "é", "\u{1F600}", "a\nb", "a\r\nb", "a\rb", "<b>", "\"",
  "'", "`", "=", "\u0000", "&", "&#;", "&#x;", "&#x110000;", "&#65", "&gt;&lt;"
];
const TEXT = [
  "x", "hello", "a b", " ", "  ", "\n", "\r\n", "\r", "\n\n", "\r\r\n", "\t", "\f", "é", "中", "\u{1F600}",
  "\u{1D4B3}", "a\u{1F600}b", "\u0000", "a\u0000b", "&amp;", "&lt", "&gt;", "&notin;", "&noti", "&notit;", "&ampx",
  "&am", "&", "&#x1F600;", "&#128512;", "&#0;", "&#128;", "&#x80;", "&#xD800;", "&#x110000;", "&#;", "&#x;", "&#65",
  "&#x41", "&AElig", "&AElig;", "&nbsp;", "&NotNestedLessLess;", "<", ">", "</", "< a", "<3", "]]>", "x\ny", "﻿",
  "�", "\u000B", "\u0001", "\u007F", "\uD800", "\uDC00x"
];
const COMMENTS = [
  "<!-- x -->", "<!---->", "<!-->", "<!--->", "<!-- a -- b -->", "<!--!>", "<!-- x --!>", "<!-- x --!", "<!--x-",
  "<!-- <!-- -->", "<!--\n-->", "<!--\r\n-->", "<!--\u{1F600}-->", "<? bogus ?>", "<?xml version=\"1.0\"?>",
  "<!bogus>", "<!>", "</ bogus>", "</3>", "<![CDATA[ x ]]>", "<![CDATA[x", "<!-", "<!--", "<!---", "<!--x--",
  "<!-- a\u0000b -->", "<!--<!-->", "<!--a--!-->"
];
const DOCTYPES = [
  "<!DOCTYPE html>", "<!doctype html>", "<!DOCTYPE HTML>", "<!DOCTYPE>", "<!DOCTYPEhtml>", "<!DOCTYPE html >",
  "<!DOCTYPE html SYSTEM \"about:legacy-compat\">",
  "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\" \"http://www.w3.org/TR/html4/strict.dtd\">",
  "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\">",
  "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\" \"http://www.w3.org/TR/html4/loose.dtd\">",
  "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" " +
    "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">",
  "<!DOCTYPE html PUBLIC '-//W3O//DTD W3 HTML Strict 3.0//EN//'>", "<!DOCTYPE html PUBLIC>", "<!DOCTYPE html SYSTEM>",
  "<!DOCTYPE html PUBLIC \"x\" 'y'>", "<!DOCTYPE html bogus>", "<!DOCTYPE html PUBLIC\"x\">", "<!DOCTYPE \u{1F600}>",
  "<!DOCTYPE html\n>", "<!DOCTYPE html PUBLIC \"-//IETF//DTD HTML//\"", "<!doctype html \u0000>", "<!DOCTYPE"
];
const RAW_BODIES = [
  "", "x", "a<b", "</", "</x>", "<!--", "<!-- <script>", "<!-- <script> -->", "<!-- <script></script> -->",
  "</scrip", "</script", "</SCRIPT", "</style", "</textarea", "</title", "\n", "\r\n", "\nx", "&amp;", "&lt",
  "\u0000", "\u{1F600}", "<![CDATA[", "-->", "<!--<script>--></script>"
];
const RAW_ELEMENTS = ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"];
const WHITESPACE = [" ", "\n", "\t", "\f", "\r", "\r\n", "  "];

function generator(seed) {
  const random = prng(seed);
  function int(n) {
    return Math.floor(random() * n);
  }
  function pick(array) {
    return array[int(array.length)];
  }
  function chance(p) {
    return random() < p;
  }

  function tagName() {
    const name = chance(0.6) ? pick(COMMON_TAGS) : pick(TAGS);
    // Tag names are ASCII case-insensitive; foreign ones are case-adjusted.
    return chance(0.1) ? name.toUpperCase() : name;
  }

  function attribute() {
    const name = pick(ATTR_NAMES);
    switch (int(5)) {
      case 0:
        return name;
      case 1:
        return `${name}=${pick(ATTR_VALUES).replace(/[\s>]/g, "")}`;
      case 2:
        return `${name}='${pick(ATTR_VALUES).replace(/'/g, "")}'`;
      case 3:
        return `${name} = "${pick(ATTR_VALUES).replace(/"/g, "")}"`;
      default:
        return `${name}="${pick(ATTR_VALUES).replace(/"/g, "")}"`;
    }
  }

  function attributes() {
    let result = "";
    const count = chance(0.5) ? 0 : 1 + int(4);
    for (let i = 0; i < count; i++) {
      result += pick(WHITESPACE) + attribute();
    }
    return result;
  }

  function startTag(name = tagName()) {
    const selfClosing = chance(0.1) ? pick(["/", " /", "/ "]) : "";
    return `<${name}${attributes()}${selfClosing}${chance(0.05) ? pick(WHITESPACE) : ""}>`;
  }

  function endTag(name = tagName()) {
    if (chance(0.05)) {
      return pick(["</br>", "</p>", "</>", "</ >", "</body>", "</html>", "</head>", "</table>", "</template>"]);
    }
    return `</${name}${chance(0.05) ? attributes() : ""}${chance(0.05) ? "/" : ""}>`;
  }

  function rawText() {
    const name = pick(RAW_ELEMENTS);
    let result = startTag(name);
    const count = int(4);
    for (let i = 0; i < count; i++) {
      result += pick(RAW_BODIES);
    }
    if (chance(0.85)) {
      result += endTag(chance(0.1) ? name.toUpperCase() : name);
    }
    return result;
  }

  // A few shapes that exercise specific algorithms, filled in with random pieces.
  function structure() {
    switch (int(10)) {
      case 0: { // Misnested formatting: the adoption agency algorithm.
        const [a, b] = [pick(["a", "b", "i", "nobr", "em", "font", "s"]), pick(["p", "div", "table", "b", "i", "a"])];
        return `<${a}>${text()}<${b}>${text()}</${a}>${text()}</${b}>`;
      }
      case 1: // Content in tables where it does not belong: foster parenting and table text.
        return `<table>${text()}<tr>${text()}<td>${text()}</td>${text()}${startTag()}${text()}</tr>${text()}</table>`;
      case 2: // Foreign content and the elements that break out of it.
        return `<svg${attributes()}><g>${text()}<foreignObject>${text()}${startTag()}</foreignObject>` +
          `${chance(0.5) ? "<p>" : "<desc><b>"}${text()}</svg>`;
      case 3:
        return `<math><mi>${text()}<mglyph/><annotation-xml encoding="${pick(["text/html", "x"])}"><svg><p>` +
          `${text()}</math>`;
      case 4:
        return `<template>${chance(0.5) ? "<tr>" : "<td>"}${text()}<template>${startTag()}</template>` +
          `${text()}</template>`;
      case 5:
        return `<select>${text()}<option>${text()}<optgroup>${startTag()}<option>${text()}</select>`;
      case 6:
        return `<table><form>${text()}<input type=hidden><input>${text()}</table>`;
      case 7:
        return `<pre>${pick(["\n", "\r\n", "\r", "", "\n\n"])}${text()}</pre><textarea>${pick(["\n", "\r\n", ""])}` +
          `${text()}</textarea>`;
      case 8:
        return `<frameset>${text()}<frame>${pick(COMMENTS)}</frameset>${text()}`;
      default:
        return `<ul><li>${text()}<li>${startTag()}${text()}<dd>${text()}<dt></ul>`;
    }
  }

  function text() {
    let result = "";
    const count = int(3);
    for (let i = 0; i < count; i++) {
      result += pick(TEXT);
    }
    return result;
  }

  function piece() {
    const roll = random();
    if (roll < 0.25) {
      return startTag();
    }
    if (roll < 0.40) {
      return endTag();
    }
    if (roll < 0.62) {
      return text();
    }
    if (roll < 0.70) {
      return pick(COMMENTS);
    }
    if (roll < 0.73) {
      return pick(DOCTYPES);
    }
    if (roll < 0.82) {
      return rawText();
    }
    if (roll < 0.99) {
      return structure();
    }
    return "<plaintext>";
  }

  return function document() {
    let result = chance(0.5) ? pick(DOCTYPES) + (chance(0.5) ? pick(WHITESPACE) : "") : "";
    const count = 1 + int(25);
    for (let i = 0; i < count; i++) {
      result += piece();
    }
    // End of input in the middle of something (a tag, an attribute, a comment, a character reference, ...).
    if (chance(0.25)) {
      result = result.slice(0, int(result.length + 1));
    }
    return result;
  };
}

// Returns `count` documents generated from `seed`.
exports.corpus = (seed, count) => {
  const document = generator(seed);
  return Array.from({ length: count }, document);
};
