"use strict";
const htmlEncodingSniffer = require("html-encoding-sniffer");
const native = require("../../native");

// https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm for HTML (not XML) bytes: the BOM,
// then the transport-layer encoding label, then the prescan, then `defaultEncoding`. The addon has a port of
// html-encoding-sniffer, used when available so that the bytes can go to the native parser undecoded.
exports.sniffHTMLEncoding = (bytes, { transportLayerEncodingLabel, defaultEncoding = "windows-1252" }) => {
  if (native === null) {
    return htmlEncodingSniffer(bytes, { transportLayerEncodingLabel, defaultEncoding });
  }
  return native.sniffHtmlEncoding(bytes, transportLayerEncodingLabel) ?? defaultEncoding;
};
