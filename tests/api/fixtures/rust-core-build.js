"use strict";
// Parses a fixed set of inputs with the Rust core build selected by JSDOM_NATIVE, and prints the results as JSON. Run
// by tests/api/rust-core-builds.js, once per build. Exits with code 3 if the build cannot be loaded.

let JSDOM;
try {
  ({ JSDOM } = require("../../.."));
} catch (e) {
  if (/could not load its Rust core/u.test(e.message)) {
    process.stderr.write(e.message);
    process.exit(3);
  }
  throw e;
}

const results = {};

// XML documents: a small one, and one whose instruction stream does not fit in the reusable buffer.
const smallXML = `<?xml version="1.0"?><root xmlns:p="urn:p"><p:a x="1">text<b/></p:a><!--c--><?pi data?></root>`;
let dom = new JSDOM(smallXML, { contentType: "application/xml" });
results.smallXML = dom.serialize();

const items = [];
for (let i = 0; i < 5000; i++) {
  items.push(`<item n="${i}">value ${i}</item>`);
}
dom = new JSDOM(`<list>${items.join("")}</list>`, { contentType: "application/xml" });
const list = dom.window.document.documentElement;
results.largeXML = { localName: list?.localName, children: list?.children.length, last: list?.lastChild?.outerHTML };

// An XML fragment, through innerHTML on an element of an XML document.
dom = new JSDOM(`<root xmlns="urn:x"/>`, { contentType: "application/xml" });
const root = dom.window.document.documentElement;
if (root !== null) {
  root.innerHTML = `<a><b c="d"/>e</a><f/>`;
}
results.xmlFragment = root?.outerHTML;

// XML through DOMParser, and an XML document parsed from bytes.
dom = new JSDOM();
const parsed = new dom.window.DOMParser().parseFromString(`<a><b>x</b></a>`, "text/xml");
results.domParser = new dom.window.XMLSerializer().serializeToString(parsed);
dom = new JSDOM(Buffer.from(`<?xml version="1.0" encoding="utf-8"?><a>café</a>`), { contentType: "text/xml" });
results.xmlBytes = [dom.window.document.characterSet, dom.window.document.documentElement?.outerHTML];

// HTML: a document with source locations, one with scripts, a fragment, and bytes with a <meta charset>.
dom = new JSDOM(`<!doctype html><table><tr><td>x</table><p id=p>hi`, { includeNodeLocations: true });
results.htmlLocations = [dom.serialize(), dom.nodeLocation(dom.window.document.getElementById("p"))];
dom = new JSDOM(`<p>a<script>document.write("<b>b</b>")</script>c`, { runScripts: "dangerously" });
results.htmlScripts = dom.serialize();
results.htmlFragment = JSDOM.fragment(`<td>a<b>b<i>c</b>d`).childNodes.length;
dom = new JSDOM(Buffer.from(`<meta charset="iso-8859-5"><p>é`, "latin1"));
results.htmlBytes = [dom.window.document.characterSet, dom.window.document.body.textContent];

process.stdout.write(JSON.stringify(results));
