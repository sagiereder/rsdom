"use strict";
const native = require("../../native");

// https://html.spec.whatwg.org/multipage/parsing.html#encoding-sniffing-algorithm for HTML (not XML) bytes: the BOM,
// then the transport-layer encoding label, then the prescan, then `defaultEncoding`. The addon has a port of
// html-encoding-sniffer, so that the bytes can go to the native parser undecoded.
exports.sniffHTMLEncoding = (bytes, { transportLayerEncodingLabel, defaultEncoding = "windows-1252" }) => {
  return native.sniffHtmlEncoding(bytes, transportLayerEncodingLabel) ?? defaultEncoding;
};

// Sniffing for XML bytes, as html-encoding-sniffer's XML mode (which follows WebKit): the BOM, then the transport-layer
// encoding label, then the UTF-16 `<?x` signatures or the XML declaration, then `defaultEncoding`.
exports.sniffXMLEncoding = (bytes, { transportLayerEncodingLabel, defaultEncoding = "UTF-8" }) => {
  return native.sniffXmlEncoding(bytes, transportLayerEncodingLabel) ?? defaultEncoding;
};
