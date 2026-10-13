"use strict";
// Differential tests of rsdom's encoding sniffing (src/native/src/html_encoding.rs) against html-encoding-sniffer, the
// package jsdom uses (now a development dependency of rsdom): for HTML and for XML bytes, with and without a
// transport-layer encoding label, both must give the same encoding for every input. The inputs are a seeded corpus
// built around BOMs, UTF-16 signatures, XML declarations and <meta> charsets, with labels valid, invalid, padded,
// differently cased and non-ASCII, and lengths around the limits the sniffers have (8 bytes for XML, 1024 for the
// <meta> prescan).
//
// RSDOM_FUZZ_SEED and RSDOM_FUZZ_COUNT change the corpus.

const assert = require("node:assert/strict");
const { describe, it } = require("mocha-sugar-free");
const sniffer = require("html-encoding-sniffer");
const { sniffHTMLEncoding, sniffXMLEncoding } = require("../../src/jsdom/browser/parser/html-encoding.js");

const FUZZ_SEED = Number(process.env.RSDOM_FUZZ_SEED ?? 20261013);
const FUZZ_COUNT = Number(process.env.RSDOM_FUZZ_COUNT ?? 3000) * 10;

// mulberry32, as in fuzz.js.
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

const LABELS = [
  "utf-8", "UTF-8", "utf8", "unicode-1-1-utf-8", " utf-8 ", "\tutf-8\n", "utf-16", "utf-16le", "UTF-16BE", "unicode",
  "ucs-2", "iso-8859-1", "latin1", "us-ascii", "ascii", "windows-1252", "cp1252", "iso-8859-2", "ISO-8859-5",
  "koi8-r", "KOI8-U", "shift_jis", "sjis", "euc-jp", "iso-2022-jp", "gbk", "gb2312", "gb18030", "big5", "euc-kr",
  "iso-2022-kr", "replacement", "csiso2022kr", "hz-gb-2312", "x-user-defined", "windows-874", "x-mac-cyrillic",
  "macintosh", "iso-8859-8-i", "iso-8859-16", "ibm866", "utf-7", "utf-32", "bogus", "", " ", "utfé-8", "utf 8",
  "ÿutf-8", "utf-8\u0000", "UTF8", "x-sjis", "csshiftjis"
];

function bytesOf(string) {
  return Buffer.from(string, "latin1");
}

function generate(random) {
  function int(n) {
    return Math.floor(random() * n);
  }
  function pick(array) {
    return array[int(array.length)];
  }
  function label() {
    return pick(LABELS);
  }
  function quote() {
    return pick(["\"", "'", "", "`"]);
  }
  function space() {
    return pick(["", " ", "  ", "\t", "\n", "\u0000", "\u000b", "\r\n"]);
  }
  const parts = [];
  switch (int(10)) {
    case 0:
      parts.push(pick(["ï»¿", "ÿþ", "þÿ", "ï»", "þ"]));
      break;
    case 1:
      parts.push(pick(["<\u0000?\u0000x\u0000", "\u0000<\u0000?\u0000x", "<\u0000?\u0000", "\u0000<\u0000?"]));
      break;
    default: break;
  }
  const pieces = int(4);
  for (let i = 0; i < pieces; i++) {
    switch (int(8)) {
      case 0:
      case 1: {
        const q = quote();
        parts.push(`${pick(["<?xml", "<?XML", "<?xml ", " <?xml", "<?xm"])}${pick([" version=\"1.0\"", "", " v"])}` +
          `${pick([" encoding", "encoding", " ENCODING", " xencoding", " encodin"])}${space()}=${space()}` +
          `${q}${label()}${pick([q, "", "\"", "'"])}${pick(["?>", ">", "", " standalone='yes'?>"])}`);
        break;
      }
      case 2:
        parts.push(`<meta${space()}charset${space()}=${space()}${quote()}${label()}${quote()}${pick([">", "/>", ""])}`);
        break;
      case 3:
        parts.push(`<meta http-equiv=${quote()}content-type${quote()} content=${quote()}text/html;` +
          `${space()}charset=${pick(["", "'", "\""])}${label()}${quote()}>`);
        break;
      case 4:
        parts.push(pick(["<!-- x -->", "<!--", "<p>", "<a b='c'>", "<!doctype html>", "</meta>", "<?pi?>", "<", "<!"]));
        break;
      case 5:
        parts.push(" ".repeat(pick([0, 1, 7, 8, 1000, 1010, 1020, 1030])));
        break;
      case 6: {
        let s = "";
        const n = int(16);
        for (let j = 0; j < n; j++) {
          s += String.fromCharCode(int(256));
        }
        parts.push(s);
        break;
      }
      default:
        parts.push(pick(["<head>", "<body>", "text", "é", "<script>", "<meta>", "<meta charset>"]));
    }
  }
  let bytes = bytesOf(parts.join(""));
  if (random() < 0.2) {
    bytes = bytes.subarray(0, int(bytes.length + 1));
  }
  const transportLayerEncodingLabel = random() < 0.75 ? undefined : label();
  return { bytes, transportLayerEncodingLabel, defaultEncoding: pick([undefined, "UTF-8", "windows-1252", "KOI8-R"]) };
}

function corpus(seed, count) {
  const random = prng(seed);
  const cases = [];
  for (let i = 0; i < count; i++) {
    cases.push(generate(random));
  }
  return cases;
}

function check(cases, xml) {
  const failures = [];
  for (const { bytes, transportLayerEncodingLabel, defaultEncoding } of cases) {
    const options = { transportLayerEncodingLabel };
    if (defaultEncoding !== undefined) {
      options.defaultEncoding = defaultEncoding;
    }
    const expected = sniffer(bytes, { ...options, xml });
    const actual = xml ? sniffXMLEncoding(bytes, options) : sniffHTMLEncoding(bytes, options);
    if (actual !== expected) {
      failures.push(`${JSON.stringify(bytes.toString("latin1"))} (transport label ` +
        `${JSON.stringify(transportLayerEncodingLabel)}, default ${defaultEncoding}): ` +
        `html-encoding-sniffer gives ${expected}, rsdom ${actual}`);
    }
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} differences, the first ones:\n${failures.slice(0, 5).join("\n")}`
  );
}

describe("Differential: rsdom's encoding sniffing against html-encoding-sniffer", () => {
  const cases = corpus(FUZZ_SEED, FUZZ_COUNT);

  it(`sniffs ${cases.length} HTML byte streams (seed ${FUZZ_SEED}) identically`, () => {
    check(cases, false);
  });

  it(`sniffs ${cases.length} XML byte streams (seed ${FUZZ_SEED}) identically`, () => {
    check(cases, true);
  });

  it("sniffs every label in an XML declaration and as the transport-layer label identically", () => {
    const fixed = [];
    for (const label of LABELS) {
      for (const q of ["\"", "'"]) {
        fixed.push({ bytes: bytesOf(`<?xml version="1.0" encoding=${q}${label}${q}?><a/>`) });
        fixed.push({ bytes: bytesOf(`<meta charset=${q}${label}${q}><p>`) });
      }
      fixed.push({ bytes: bytesOf("<a/>"), transportLayerEncodingLabel: label });
    }
    check(fixed, true);
    check(fixed, false);
  });
});
