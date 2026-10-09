"use strict";
// Huge tables: 5k rows x 10 cols.
const { freshDom, rng } = require("../lib/common.js");

const ROWS = 5000;
const COLS = 10;

function tableHtml() {
  const rand = rng(7);
  let s = "<table id=\"t\"><thead><tr>";
  for (let c = 0; c < COLS; c++) {
    s += `<th scope="col">Col ${c}</th>`;
  }
  s += "</tr></thead><tbody>";
  for (let r = 0; r < ROWS; r++) {
    s += `<tr class="row${r % 2 ? " alt" : ""}" data-id="${r}">`;
    for (let c = 0; c < COLS; c++) {
      const v = c === 2 ? Math.floor(rand() * 100000) : `r${r}c${c}`;
      s += `<td class="c${c}">${v}</td>`;
    }
    s += "</tr>";
  }
  return s + "</tbody></table>";
}

function withTable({ JSDOM }, { html }) {
  const dom = freshDom(JSDOM, `<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
  return { dom, document: dom.window.document, table: dom.window.document.getElementById("t") };
}
const teardown = st => st.dom.window.close();
const prepare = () => ({ html: tableHtml() });

module.exports = [
  {
    name: "tables/parse-innerHTML",
    group: "tables",
    desc: `parse ${ROWS}x${COLS} table via innerHTML`,
    prepare,
    setup: ({ JSDOM }, { html }) => ({ dom: freshDom(JSDOM), html }),
    run({ dom, html }) {
      dom.window.document.body.innerHTML = html;
    },
    teardown
  },
  {
    name: "tables/rows-cells-access",
    group: "tables",
    desc: "iterate table.rows / row.cells, read textContent of every cell (x3)",
    prepare,
    setup: withTable,
    run({ table }) {
      let total = 0;
      for (let rep = 0; rep < 3; rep++) {
        const { rows } = table;
        for (let r = 0; r < rows.length; r++) {
          const { cells } = rows[r];
          for (let c = 0; c < cells.length; c++) {
            total += cells[c].textContent.length;
          }
        }
      }
      return total;
    },
    teardown
  },
  {
    name: "tables/nth-child-query",
    group: "tables",
    desc: "querySelectorAll('td:nth-child(3)'), 'tr.alt > td.c5', 'tbody tr:nth-child(odd) td:last-child'",
    prepare,
    setup: withTable,
    run({ document }) {
      return document.querySelectorAll("td:nth-child(3)").length +
        document.querySelectorAll("tr.alt > td.c5").length +
        document.querySelectorAll("tbody tr:nth-child(odd) td:last-child").length;
    },
    teardown
  },
  {
    name: "tables/sort-rows",
    group: "tables",
    desc: "sort rows by numeric column 3 by re-appending tr nodes (asc then desc)",
    prepare,
    setup: withTable,
    run({ table }) {
      const tbody = table.tBodies[0];
      for (const dir of [1, -1]) {
        const rows = Array.from(tbody.rows);
        const keyed = rows.map(tr => [Number(tr.cells[2].textContent), tr]);
        keyed.sort((a, b) => dir * (a[0] - b[0]));
        for (const [, tr] of keyed) {
          tbody.appendChild(tr);
        }
      }
    },
    teardown
  },
  {
    name: "tables/serialize",
    group: "tables",
    desc: "table.outerHTML (x4)",
    prepare,
    setup: withTable,
    run({ table }) {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        n += table.outerHTML.length;
      }
      return n;
    },
    teardown
  }
];
