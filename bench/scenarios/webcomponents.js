"use strict";
// Web components: custom elements with observedAttributes + open shadow roots (Lit/Stencil/Shoelace-style
// design-system components), upgraded on define, then attribute updates, shadow-root queries and composed events.
const { freshDom, check } = require("../lib/common.js");

const N = 500;
const TAGS = ["x-button", "x-card", "x-badge", "x-input", "x-dialog"];

function shadowTemplate(tag) {
  return `<style>:host { display: block; contain: content; } :host([hidden]) { display: none; } ` +
    `:host([variant="primary"]) .base { color: white; background: rgb(0, 90, 200); } ` +
    `:host([size="small"]) .base { font-size: 12px; } .base[aria-disabled="true"] { opacity: .5; } ` +
    `::slotted(*) { margin: 0; } .label ::slotted(span) { font-weight: 600; }</style>` +
    `<div class="base" part="base" role="group"><span class="prefix"><slot name="prefix"></slot></span>` +
    `<span class="label" part="label"><slot></slot></span><span class="count" part="count">0</span>` +
    `<button class="action" type="button" part="action" aria-label="${tag} action">x</button>` +
    `<slot name="suffix"></slot></div>`;
}

// Defines the 5 components against this window's registry; returns the per-window stats object.
function defineAll(window) {
  const stats = { constructed: 0, connected: 0, attrChanges: 0 };
  for (const tag of TAGS) {
    const template = shadowTemplate(tag);
    window.customElements.define(tag, class extends window.HTMLElement {
      static get observedAttributes() {
        return ["variant", "size", "count", "disabled"];
      }
      constructor() {
        super();
        stats.constructed++;
        this.attachShadow({ mode: "open" });
      }
      connectedCallback() {
        stats.connected++;
        if (!this.shadowRoot.firstChild) {
          this.shadowRoot.innerHTML = template;
        }
      }
      attributeChangedCallback(name, oldValue, value) {
        stats.attrChanges++;
        const root = this.shadowRoot;
        if (!root.firstChild) {
          return;
        }
        if (name === "count") {
          root.querySelector(".count").textContent = value;
        } else if (name === "disabled") {
          root.querySelector(".base").setAttribute("aria-disabled", value === null ? "false" : "true");
        }
      }
    });
  }
  return stats;
}

function lightDomHtml() {
  let s = "<main id=\"app\">";
  for (let i = 0; i < N; i++) {
    const tag = TAGS[i % TAGS.length];
    s += `<${tag} id="w${i}" variant="${i % 3 ? "neutral" : "primary"}" size="medium">` +
      `<span slot="prefix">*</span><span>Label ${i}</span>${i % 4 ? "" : "<em slot=\"suffix\">new</em>"}</${tag}>`;
  }
  return `${s}</main>`;
}

module.exports = [
  {
    name: "webcomponents/shadow-render",
    group: "webcomponents",
    desc: `parse ${N} custom elements (5 kinds), customElements.define() upgrades them (attachShadow + shadowRoot.innerHTML ` +
      "with :host/::slotted styles + slots), then 2000 attribute changes, shadowRoot queries, assignedNodes(), composed events",
    caveats: {
      "happy-dom": "does less work: upgrading a parsed element does not call attributeChangedCallback for its existing " +
        `observed attributes (${N * 3 + N / 5} calls instead of ${N * 5 + N / 5}); wrong results: composed events ` +
        "seen from document are not retargeted (event.target is the button inside the shadow root, not the host)"
    },
    prepare: () => ({ html: lightDomHtml() }),
    setup(ctx, { html }) {
      const dom = freshDom(ctx, `<!DOCTYPE html><html><head></head><body>${html}</body></html>`);
      return { dom, impl: ctx.impl };
    },
    run({ dom, impl }) {
      const { window } = dom;
      const { document } = window;
      const stats = defineAll(window);
      check(`${stats.constructed}/${stats.connected}`, `${N}/${N}`, "upgraded/connected", impl);
      const els = Array.from(document.getElementById("app").children);
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        el.setAttribute("count", String(i));
        el.setAttribute("variant", i % 2 ? "primary" : "neutral");
        el.setAttribute("size", "small");
        el.toggleAttribute("disabled", i % 5 === 0);
      }
      let composedHits = 0;
      let hostTargets = 0;
      document.addEventListener("x-action", e => {
        composedHits++;
        if (TAGS.includes(e.target.localName)) {
          hostTargets++;
        }
      });
      let found = 0;
      let slotted = 0;
      for (const el of els) {
        const root = el.shadowRoot;
        if (root.querySelector(".count").textContent === el.getAttribute("count")) {
          found++;
        }
        if (root.querySelector(".base[aria-disabled='true']")) {
          found++;
        }
        slotted += root.querySelector("slot:not([name])").assignedNodes().length +
          root.querySelector("slot[name=suffix]").assignedElements().length;
        const button = root.querySelector("button.action");
        button.dispatchEvent(new window.CustomEvent("x-action", { bubbles: true, composed: true, detail: el.id }));
        // non-composed events must not escape the shadow root
        button.dispatchEvent(new window.CustomEvent("x-action", { bubbles: true, composed: false }));
      }
      // upgrade fires attributeChangedCallback for the 2 pre-existing observed attributes (except on happy-dom)
      check(stats.attrChanges, { "default": N * 5 + N / 5, "happy-dom": N * 3 + N / 5 }, "attributeChangedCallback calls", impl);
      check(`${found}/${slotted}`, `${N + N / 5}/${N + N / 4}`, "shadow queries / slotted nodes", impl);
      check(`${composedHits}/${hostTargets}`, { "default": `${N}/${N}`, "happy-dom": `${N}/0` }, "composed events reaching document / retargeted to host", impl);
      return found;
    },
    teardown: st => st.dom.close()
  }
];
