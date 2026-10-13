"use strict";
// Parsing with parse5 (the oracle) and with rsdom, and comparing the results. See html-parser.js.

const parse5 = require("parse5");

const { JSDOM, VirtualConsole } = require("../..");
const { implForWrapper } = require("../../src/generated/idl/utils.js");
const { dumpParse5, dumpDOM, firstDifference } = require("./tree-dump");

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// parse5's default tree adapter, except that a second <html> or <body> start tag sets all of its attributes on the
// existing element, replacing the values of those it already has, as jsdom's tree adapter for parse5 always did (the
// specification only adds the missing ones).
const treeAdapter = {
  ...parse5.defaultTreeAdapter,
  adoptAttributes(recipient, attrs) {
    for (const attr of attrs) {
      const existing = recipient.attrs.find(a => a.name === attr.name && a.namespace === attr.namespace);
      if (existing) {
        existing.value = attr.value;
      } else {
        recipient.attrs.push(attr);
      }
    }
  }
};

// parse5 deviates from the specification in a few cases (which the fuzz corpus finds), where rsdom follows the
// specification. The oracle is parse5 corrected to the specification in those cases:
//
// 1. "Reset the insertion mode appropriately" looks for HTML elements (a select, a template, a frameset, ...), but
//    parse5 looks at element names only, whatever their namespace: in "<svg><select><desc><table><table>", it takes the
//    SVG select element for an HTML one. A MathML or SVG template even makes parse5 read an empty stack of template
//    insertion modes and drop the rest of the input.
const { TAG_ID } = parse5.html;
const resetInsertionMode = parse5.Parser.prototype._resetInsertionMode;
parse5.Parser.prototype._resetInsertionMode = function () {
  const { openElements } = this;
  const { tagIDs } = openElements;
  const saved = { tagIDs: tagIDs.slice(), fragmentContextID: this.fragmentContextID };
  for (let i = 0; i <= openElements.stackTop; i++) {
    if (this.treeAdapter.getNamespaceURI(openElements.items[i]) !== HTML_NS) {
      tagIDs[i] = TAG_ID.UNKNOWN;
    }
  }
  if (this.fragmentContext && this.treeAdapter.getNamespaceURI(this.fragmentContext) !== HTML_NS) {
    this.fragmentContextID = TAG_ID.UNKNOWN;
  }
  try {
    resetInsertionMode.call(this);
  } finally {
    tagIDs.splice(0, saved.tagIDs.length, ...saved.tagIDs);
    this.fragmentContextID = saved.fragmentContextID;
  }
};
// 2. A U+000D CARRIAGE RETURN character token (only a character reference such as "&#13;" produces one) is whitespace
//    to tree construction (in frameset, in table text, before the head, ...), but parse5's tokenizer does not make it
//    a whitespace character token.
const emitCodePoint = parse5.Tokenizer.prototype._emitCodePoint;
parse5.Tokenizer.prototype._emitCodePoint = function (cp) {
  if (cp === 0x0D) {
    this._appendCharToCurrentCharacterToken(parse5.Token.TokenType.WHITESPACE_CHARACTER, "\r");
  } else {
    emitCodePoint.call(this, cp);
  }
};

function compareDocument(html, { scripting = false } = {}) {
  const expected = dumpParse5(
    parse5.parse(html, { treeAdapter, sourceCodeLocationInfo: true, scriptingEnabled: scripting }),
    { locations: true }
  );

  const dom = new JSDOM(html, {
    includeNodeLocations: true,
    // The inputs include broken style sheets, which would be reported to the console.
    virtualConsole: new VirtualConsole(),
    // With runScripts: "dangerously", the parser runs with scripting enabled (which changes how <noscript> parses).
    // The inputs' scripts do not modify the document.
    ...scripting ? { runScripts: "dangerously" } : {}
  });
  try {
    const actual = dumpDOM(dom.window.document, { locationOf: node => dom.nodeLocation(node) });
    return firstDifference(expected, actual);
  } finally {
    dom.window.close();
  }
}

// `context` is in the html5lib test format: a local name, optionally preceded by "svg " or "math ".
let fragmentDOM;
function compareFragment(html, context) {
  let [namespace, localName] = [HTML_NS, context];
  if (context.startsWith("svg ")) {
    [namespace, localName] = [SVG_NS, context.slice(4)];
  } else if (context.startsWith("math ")) {
    [namespace, localName] = [MATHML_NS, context.slice(5)];
  }

  fragmentDOM ??= new JSDOM();
  const { document } = fragmentDOM.window;
  const element = document.createElementNS(namespace, localName);
  // The scripting flag of fragment parsing comes from the document the nodes are created in. For a <template>, that
  // is the template contents owner document, which has no browsing context, and so (in jsdom) default parse options:
  // scripting enabled.
  const isTemplate = namespace === HTML_NS && localName === "template";
  const ownerDocument = implForWrapper(isTemplate ? element.content : element)._ownerDocument;
  const scriptingEnabled = ownerDocument._parseOptions.scriptingEnabled !== false;

  const contextElement = parse5.defaultTreeAdapter.createElement(localName, namespace, []);
  const expected = dumpParse5(parse5.parseFragment(contextElement, html, { treeAdapter, scriptingEnabled }), {
    locations: false
  });

  element.innerHTML = html;
  const fragment = document.createDocumentFragment();
  fragment.append(...(isTemplate ? element.content : element).childNodes);
  const actual = dumpDOM(fragment, { locationOf: null });
  return firstDifference(expected, actual);
}

module.exports = { compareDocument, compareFragment };
