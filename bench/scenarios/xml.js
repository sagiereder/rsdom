"use strict";
// XML/SVG documents: a ~1MB generated SVG of the kind exported by design tools and charting libraries (Inkscape
// metadata in its own namespaces, RDF/Dublin Core, <defs> with gradients and symbols, xlink:href <use> references,
// grouped paths with transforms and styles), parsed with DOMParser("image/svg+xml"), round-tripped through
// XMLSerializer, and queried with the namespace-aware APIs that SVG tooling (svgo-style optimizers, icon pipelines,
// chart tests) uses.
const { freshDom, rng, check } = require("../lib/common.js");

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const INK_NS = "http://www.inkscape.org/namespaces/inkscape";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const N_GROUPS = 300;

function generateSvg() {
  const rand = rng(77);
  const num = () => (rand() * 1000).toFixed(2);
  const color = () => `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0")}`;
  let s = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n" +
    `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" xmlns:inkscape="${INK_NS}" ` +
    "xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:cc=\"http://creativecommons.org/ns#\" " +
    `xmlns:dc="${DC_NS}" width="1000" height="1000" viewBox="0 0 1000 1000" version="1.1" id="svg1" inkscape:version="1.3.2">\n` +
    "<metadata id=\"metadata1\"><rdf:RDF><cc:Work rdf:about=\"\"><dc:format>image/svg+xml</dc:format>" +
    "<dc:type rdf:resource=\"http://purl.org/dc/dcmitype/StillImage\"/><dc:title>Generated chart</dc:title>" +
    "<dc:creator><cc:Agent><dc:title>bench</dc:title></cc:Agent></dc:creator></cc:Work></rdf:RDF></metadata>\n<defs id=\"defs1\">";
  for (let i = 0; i < 60; i++) {
    s += `<linearGradient id="grad${i}" x1="0" y1="0" x2="1" y2="${(i % 2)}" inkscape:collect="always">` +
      `<stop offset="0" style="stop-color:${color()};stop-opacity:1"/><stop offset="1" style="stop-color:${color()};stop-opacity:0.${i % 10}"/></linearGradient>`;
  }
  for (let i = 0; i < 40; i++) {
    s += `<symbol id="icon${i}" viewBox="0 0 16 16"><title>icon ${i}</title><path d="M${i % 16} 0L16 ${i % 16}L0 16Z"/></symbol>`;
  }
  s += "<clipPath id=\"clip\"><rect x=\"0\" y=\"0\" width=\"1000\" height=\"1000\"/></clipPath></defs>\n" +
    "<style type=\"text/css\"><![CDATA[ .series path { fill: none; } .label { font: 10px sans-serif; } ]]></style>\n";
  for (let g = 0; g < N_GROUPS; g++) {
    s += `<g id="layer${g}" inkscape:groupmode="layer" inkscape:label="Layer ${g} &amp; data" class="series s${g % 7}" ` +
      `transform="translate(${num()},${num()}) rotate(${g % 360})" clip-path="url(#clip)">\n`;
    // one bar/line chart series: paths, rects, circles, text, and <use> icon references
    for (let k = 0; k < 6; k++) {
      let d = `M${num()},${num()}`;
      for (let p = 0; p < 6; p++) {
        d += ` C${num()},${num()} ${num()},${num()} ${num()},${num()}`;
      }
      s += `<path id="p${g}_${k}" d="${d}" style="fill:url(#grad${(g + k) % 60});stroke:${color()};stroke-width:${1 + (k % 3)}" inkscape:connector-curvature="0"/>\n`;
    }
    for (let k = 0; k < 4; k++) {
      s += `<rect x="${num()}" y="${num()}" width="${num()}" height="${num()}" rx="2" fill="${color()}" data-value="${num()}"/>`;
    }
    s += `<circle cx="${num()}" cy="${num()}" r="${(rand() * 10).toFixed(1)}" fill="${color()}"/>`;
    s += `<use xlink:href="#icon${g % 40}" x="${num()}" y="${num()}" width="16" height="16"/>`;
    s += `<use xlink:href="#icon${(g * 3) % 40}" x="${num()}" y="${num()}" width="16" height="16"/>`;
    s += `<text class="label" x="${num()}" y="${num()}"><tspan dx="2">Series ${g} &lt;${g % 7}&gt;</tspan></text>`;
    s += `<desc>Data series ${g}; values in ${g % 2 ? "kWh" : "EUR"}</desc>\n</g>\n`;
  }
  return `${s}</svg>\n`;
}

const SVG_LENGTH = 979096;
// happy-dom's XML parser stops at the CDATA section inside <style> and returns a truncated document (318 elements)
const UNSUPPORTED = {
  "happy-dom": "DOMParser('image/svg+xml') stops at the <style><![CDATA[...]]></style> section: truncated document"
};
const N_ELEMENTS = 1 + 9 + 1 + 60 * 3 + 40 * 3 + 2 + 1 + N_GROUPS * (1 + 6 + 4 + 1 + 2 + 2 + 1);

function setupParser(ctx, { svg }) {
  const dom = freshDom(ctx);
  return { dom, svg, impl: ctx.impl };
}

// One svgo-style pass: the namespace-aware reads an SVG optimizer or icon pipeline does over the parsed tree, then
// the edit it makes (drop the editor metadata of one layer, inline one <use> by cloning its symbol's path), so every
// pass sees a different document.
function optimizePass(doc, pass, impl) {
  const paths = doc.getElementsByTagNameNS(SVG_NS, "path");
  const uses = doc.getElementsByTagNameNS(SVG_NS, "use");
  const dcTitles = doc.getElementsByTagNameNS(DC_NS, "title");
  const anyNs = doc.getElementsByTagNameNS("*", "title");
  let hrefs = 0;
  for (const u of uses) {
    const ref = u.getAttributeNS(XLINK_NS, "href");
    hrefs += doc.getElementById(ref.slice(1)) ? 1 : 0;
  }
  let labels = 0;
  for (const g of doc.getElementsByTagNameNS(SVG_NS, "g")) {
    labels += g.hasAttributeNS(INK_NS, "label") && g.hasAttributeNS(INK_NS, "groupmode") ? 1 : 0;
  }
  let curves = 0;
  for (const p of paths) {
    curves += p.getAttribute("d").split("C").length - 1;
  }
  const nPaths = N_GROUPS * 6 + 40 + pass;
  check(`${paths.length}/${uses.length}/${hrefs}/${dcTitles.length}/${anyNs.length}/${labels}/${curves}`,
    `${nPaths}/${N_GROUPS * 2 - pass}/${N_GROUPS * 2 - pass}/2/42/${N_GROUPS - pass}/${N_GROUPS * 36}`,
    `namespace queries (pass ${pass})`, impl);
  // edits for the next pass
  const layer = doc.getElementById(`layer${(pass * 37) % N_GROUPS}`);
  layer.removeAttributeNS(INK_NS, "label");
  layer.removeAttributeNS(INK_NS, "groupmode");
  const use = uses[(pass * 13) % uses.length];
  const symbol = doc.getElementById(use.getAttributeNS(XLINK_NS, "href").slice(1));
  const inlined = symbol.getElementsByTagNameNS(SVG_NS, "path")[0].cloneNode(true);
  inlined.setAttributeNS(null, "transform", `translate(${use.getAttribute("x")},${use.getAttribute("y")})`);
  use.replaceWith(inlined);
}

const N_PASSES = 40;

module.exports = [
  {
    name: "xml/domparser-svg",
    group: "xml",
    unsupported: UNSUPPORTED,
    desc: `DOMParser.parseFromString on a ~1MB generated SVG (Inkscape/RDF namespaces, xlink:href, ${N_GROUPS} layers, ` +
      "CDATA, entities), then count elements and check the namespaces",
    prepare: () => ({ svg: generateSvg() }),
    setup: setupParser,
    run({ dom, svg, impl }) {
      check(svg.length, SVG_LENGTH, "generated SVG length", impl);
      const doc = new dom.window.DOMParser().parseFromString(svg, "image/svg+xml");
      const root = doc.documentElement;
      check(`${root.namespaceURI}|${root.localName}|${doc.getElementsByTagName("parsererror").length}`, `${SVG_NS}|svg|0`, "parsed root", impl);
      check(doc.getElementsByTagName("*").length, N_ELEMENTS, "element count", impl);
      const tspan = doc.getElementsByTagName("tspan")[5];
      check(tspan.textContent, "Series 5 <5>", "entity-decoded text", impl);
      return N_ELEMENTS;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "xml/serializer-roundtrip",
    group: "xml",
    unsupported: UNSUPPORTED,
    desc: "XMLSerializer.serializeToString of the parsed ~1MB SVG, reparse the output, and compare element/attribute " +
      "counts and namespaces with the original",
    prepare: () => ({ svg: generateSvg() }),
    setup(ctx, shared) {
      const st = setupParser(ctx, shared);
      st.doc = new st.dom.window.DOMParser().parseFromString(st.svg, "image/svg+xml");
      return st;
    },
    run({ dom, doc, impl }) {
      const { XMLSerializer, DOMParser } = dom.window;
      const out = new XMLSerializer().serializeToString(doc);
      const again = new DOMParser().parseFromString(out, "image/svg+xml");
      const count = d => {
        let elements = 0;
        let attrs = 0;
        let xlink = 0;
        for (const el of d.getElementsByTagName("*")) {
          elements++;
          attrs += el.attributes.length;
          xlink += el.hasAttributeNS(XLINK_NS, "href") ? 1 : 0;
        }
        return `${elements}/${attrs}/${xlink}`;
      };
      const before = count(doc);
      check(count(again), before, "element/attribute/xlink counts after round trip", impl);
      check(again.documentElement.namespaceURI, SVG_NS, "root namespace after round trip", impl);
      check(new XMLSerializer().serializeToString(again).length, out.length, "second serialization length", impl);
      return out.length;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "xml/getElementsByTagNameNS",
    group: "xml",
    unsupported: UNSUPPORTED,
    desc: `${N_PASSES} svgo-style passes over the parsed ~1MB SVG: getElementsByTagNameNS(svg|dc|*), getAttributeNS ` +
      "(xlink:href resolved with getElementById, inkscape:*), path data scan; each pass strips one layer's inkscape " +
      "attributes and inlines one <use>",
    prepare: () => ({ svg: generateSvg() }),
    setup(ctx, shared) {
      const st = setupParser(ctx, shared);
      st.doc = new st.dom.window.DOMParser().parseFromString(st.svg, "image/svg+xml");
      return st;
    },
    run({ doc, impl }) {
      for (let pass = 0; pass < N_PASSES; pass++) {
        optimizePass(doc, pass, impl);
      }
      check(doc.getElementsByTagNameNS(XLINK_NS, "href").length + doc.querySelectorAll("use").length,
        N_GROUPS * 2 - N_PASSES, "remaining <use> elements", impl);
    },
    teardown: st => st.dom.close()
  }
];
