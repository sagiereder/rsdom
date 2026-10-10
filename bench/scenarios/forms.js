"use strict";
// Large form: the DOM APIs form libraries (react-hook-form, Formik, final-form) and form tests lean on — FormData
// snapshots, constraint validation, form.elements named access, input.labels, radio groups and a big <select>.
const { freshDom, check } = require("../lib/common.js");

const N_FIELDS = 200;
const N_RADIO_GROUPS = 50;
const N_OPTIONS = 500;
const KINDS = ["text", "email", "number", "tel", "url", "checkbox", "textarea", "date"];

function formHtml() {
  let s = "<form id=\"f\" action=\"/save\" novalidate>";
  for (let i = 0; i < N_FIELDS; i++) {
    const kind = KINDS[i % KINDS.length];
    const name = `field_${i}`;
    const req = i % 3 === 0 ? " required" : "";
    let c;
    if (kind === "textarea") {
      c = `<textarea id="i${i}" name="${name}" minlength="3"${req}>${i % 2 ? "" : `notes ${i}`}</textarea>`;
    } else if (kind === "checkbox") {
      c = `<input id="i${i}" type="checkbox" name="${name}" value="yes"${i % 2 ? " checked" : ""}${req}>`;
    } else if (kind === "number") {
      c = `<input id="i${i}" type="number" name="${name}" min="0" max="100" step="5" value="${(i * 5) % 120}"${req}>`;
    } else {
      const value = i % 4 === 0 ? "" : { text: `value ${i}`, email: `u${i}@example.com`, tel: `555-01${i}`, url: `https://e.com/${i}`, date: "2024-05-17" }[kind];
      const pattern = kind === "text" ? " pattern=\"[a-z ]+[0-9]*\"" : "";
      c = `<input id="i${i}" type="${kind}" name="${name}" value="${value}"${pattern}${req}>`;
    }
    // every 5th control is also wrapped in a second label
    s += `<div class="row"><label for="i${i}">Field ${i}</label>${i % 5 === 0 ? `<label class="hint"><span>hint</span>${c}</label>` : c}</div>`;
  }
  for (let g = 0; g < N_RADIO_GROUPS; g++) {
    s += `<fieldset><legend>Group ${g}</legend>`;
    for (let r = 0; r < 3; r++) {
      s += `<label><input type="radio" name="radio_${g}" value="${r}"${r === 0 ? " checked" : ""}> Option ${r}</label>`;
    }
    s += "</fieldset>";
  }
  s += "<label for=\"country\">Country</label><select id=\"country\" name=\"country\">";
  for (let o = 0; o < N_OPTIONS; o++) {
    s += `<option value="c${o}"${o === 0 ? " selected" : ""}>Country ${o}</option>`;
  }
  return `${s}</select><button type="submit">Save</button></form>`;
}

module.exports = [
  {
    name: "forms/big-form",
    group: "forms",
    desc: `${N_FIELDS}-field form + ${N_RADIO_GROUPS} radio groups + ${N_OPTIONS}-option select: new FormData x50 between ` +
      "edits, checkValidity/reportValidity, form.elements[name], input.labels, radio toggles, selectedIndex/value changes",
    prepare: () => ({ html: formHtml() }),
    setup(ctx, { html }) {
      const dom = freshDom(ctx, `<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
      return { dom, impl: ctx.impl };
    },
    run({ dom, impl }) {
      const { document, FormData } = dom.window;
      const form = document.getElementById("f");
      const select = document.getElementById("country");
      let invalidEvents = 0;
      form.addEventListener("invalid", () => invalidEvents++, true);
      // named access + labels, like a form library registering its fields
      let labels = 0;
      for (let i = 0; i < N_FIELDS; i++) {
        const el = form.elements[`field_${i}`];
        labels += el.labels.length;
      }
      check(labels, N_FIELDS + N_FIELDS / 5, "input.labels total", impl);
      let entries = 0;
      let validCount = 0;
      for (let round = 0; round < 50; round++) {
        // edit a few fields, toggle a radio group, change the select, then snapshot like an onChange handler
        for (let k = 0; k < 4; k++) {
          const i = (round * 4 + k) * 7 % N_FIELDS;
          const el = form.elements.namedItem(`field_${i}`);
          if (el.type === "checkbox") {
            el.checked = !el.checked;
          } else if (el.type === "number") {
            el.value = String((round * 13) % 130);
          } else if (el.type !== "date") {
            el.value = round % 5 === 0 ? "" : `edit ${round}`;
          }
        }
        const group = form.elements[`radio_${round % N_RADIO_GROUPS}`];
        group[(round % 2) + 1].checked = true;
        check(group.value, String((round % 2) + 1), "RadioNodeList.value", impl);
        select.selectedIndex = (round * 37) % N_OPTIONS;
        if (round % 2) {
          select.value = `c${(round * 11) % N_OPTIONS}`;
        }
        entries += Array.from(new FormData(form)).length;
        if (round % 5 === 0) {
          validCount += form.checkValidity() ? 1 : 0;
        }
      }
      for (let g = 0; g < N_RADIO_GROUPS; g++) {
        form.elements[`radio_${g}`][2].click();
      }
      const reported = form.reportValidity();
      const data = new FormData(form);
      const checkedRadios = form.querySelectorAll("input[type=radio]:checked").length;
      check(`${entries}/${validCount}/${reported}/${invalidEvents > 0}`, "11900/0/false/true", "FormData entries / validity", impl);
      check(`${data.get("radio_7")}/${data.get("country")}/${checkedRadios}`, `2/c${(49 * 11) % N_OPTIONS}/${N_RADIO_GROUPS}`,
        "final radio/select values", impl);
      check(invalidEvents, 517, "invalid events", impl);
      return entries;
    },
    teardown: st => st.dom.close()
  }
];
