"use strict";
// Accessibility-query scenarios, the hot path of @testing-library test suites (jsdom #3234, dom-testing-library
// #698/#820, user-event #577): getByRole() runs role matching, an inaccessibility check (getComputedStyle up the
// ancestor chain) and accessible-name computation (more getComputedStyle, incl. ::before/::after) for every candidate.
const { freshDom, installGlobals, check } = require("../lib/common.js");
const { makeApps } = require("./react-apps.js");

// ~300 rules aimed at the dashboard's classes, like an app stylesheet (utility classes, component rules, states).
// A few rules hide content so the hidden/visible query results depend on the cascade.
function dashboardStylesheet() {
  const colors = ["#111", "#333", "rgb(20, 40, 60)", "hsl(210 40% 50%)", "teal", "rgba(0,0,0,.6)"];
  const sels = [".app", ".app-header", ".logo", ".top-nav", ".nav-list", ".nav-item", ".nav-item.active", ".nav-link",
    ".theme-toggle", ".layout", ".sidebar", ".menu", ".menu-item", ".menu-item.selected", ".menu-label", ".content",
    ".stats", ".stat-card", ".stat-card.up", ".stat-card.down", ".stat-label", ".stat-value", ".stat-delta",
    ".table-section", ".toolbar", ".count", ".data-table", ".data-table th", ".data-table td", ".row", ".row.selected",
    ".name", ".email", ".role", ".badge", ".badge-admin", ".badge-editor", ".badge-viewer", ".score", ".status",
    ".actions", ".btn", ".btn-sm", ".btn.danger", ".settings-form", ".form-row", ".form-row label", ".feed",
    ".feed-item", ".feed-item p", ".icon", ".icon-nav", ".icon-menu", "fieldset", "legend", "input", "select",
    "textarea", "button.primary", "a:hover"];
  let css = "";
  for (let i = 0; i < 280; i++) {
    const base = sels[i % sels.length];
    const sel = [base, `.theme-light ${base}`, `.layout ${base}:not(.x${i})`, `main ${base}`, `${base}:focus-within`][Math.floor(i / sels.length) % 5];
    css += `${sel} { color: ${colors[i % colors.length]}; margin: ${i % 7}px ${i % 3}px; padding: ${i % 5}px; ` +
      `font: ${400 + (i % 3) * 100} ${11 + (i % 6)}px/1.4 system-ui, sans-serif; border-bottom: 1px solid ${colors[(i + 2) % colors.length]}; }\n`;
  }
  for (let i = 0; i < 12; i++) {
    css += `.theme-dark .c${i} { background: #${(i * 0x111111).toString(16).padStart(6, "0").slice(0, 6)}; }\n`;
  }
  // hidden content: the feed past item 40 is display:none, menu counts are visibility:hidden
  css += ".feed-item:nth-child(n+41) { display: none; }\n.menu-count { visibility: hidden; }\n" +
    ".app-header .theme-toggle::before { content: \"\"; }\n";
  return css;
}

let cachedMarkup = null;
// The React dashboard (react-apps.js) as static HTML; impl-independent because it never touches a DOM.
function dashboardMarkup() {
  if (!cachedMarkup) {
    const React = require("react");
    const server = require("react-dom/server");
    const apps = makeApps(React, require("react-dom"));
    cachedMarkup = server.renderToStaticMarkup(React.createElement(apps.Dashboard)).replace(/<link rel="preload"[^>]*>/gu, "");
  }
  return cachedMarkup;
}

function loadTestingLibrary(ctx, { react = false } = {}) {
  const boot = freshDom(ctx, "<!DOCTYPE html><html><head></head><body></body></html>", { url: "http://localhost/" });
  installGlobals(boot.window);
  const shared = { TL: require("@testing-library/dom") };
  if (react) {
    shared.React = require("react");
    shared.RTL = require("@testing-library/react");
    shared.userEvent = require("@testing-library/user-event").default;
    shared.apps = makeApps(shared.React, require("react-dom"));
  }
  return shared;
}

module.exports = [
  {
    name: "a11y/getByRole-page",
    group: "a11y",
    desc: "@testing-library/dom within(body) on the static ~3k-element dashboard + 300-rule stylesheet: 22 " +
      "getByRole(role, { name }), getAllByRole('row'/'listitem'), queryByRole(..., { hidden: true })",
    prepare(ctx) {
      const shared = loadTestingLibrary(ctx);
      shared.html = "<!DOCTYPE html><html><head><title>App</title><style>" + dashboardStylesheet() +
        `</style></head><body><div id="root">${dashboardMarkup()}</div></body></html>`;
      return shared;
    },
    setup(ctx, { TL, html }) {
      const dom = freshDom(ctx, html, { url: "http://localhost/" });
      installGlobals(dom.window);
      return { dom, TL, impl: ctx.impl };
    },
    run({ dom, TL, impl }) {
      const screen = TL.within(dom.window.document.body);
      let n = 0;
      const one = (role, name, opts) => {
        n += screen.getByRole(role, { name, ...opts }) ? 1 : 0;
      };
      one("heading", "Dashboard", { level: 1 });
      one("navigation", "Main");
      one("searchbox", "Filter");
      one("group", "Settings");
      one("button", "Dark mode");
      one("button", "Save");
      for (let i = 0; i < 12; i += 3) {
        one("link", `Section ${i}`);
      }
      for (const i of [7, 29]) {
        // the count span is visibility:hidden, so it is not part of the name
        one("link", `Menu item ${i}`);
      }
      for (let i = 0; i < 250; i += 125) {
        one("checkbox", `Select User ${i}`);
      }
      for (const i of [4, 12]) {
        one("combobox", `Field ${i}`);
      }
      for (const i of [2, 14]) {
        one("textbox", `Field ${i}`);
      }
      for (const i of [7, 11]) {
        one("spinbutton", `Field ${i}`);
      }
      one("columnheader", "Score ▲");
      one("table");
      check(n, 22, "getByRole matches", impl);
      const rows = screen.getAllByRole("row").length;
      check(rows, 251, "row count", impl);
      const visibleItems = screen.getAllByRole("listitem").length;
      const allItems = screen.getAllByRole("listitem", { hidden: true }).length;
      check(`${visibleItems}/${allItems}`, "82/102", "visible/all listitems", impl);
      const found = screen.queryByRole("searchbox", { name: "Filter", hidden: true }) &&
        screen.queryByRole("heading", { name: "Dashboard", hidden: true });
      const missing = screen.queryByRole("button", { name: "Does not exist", hidden: true });
      check(Boolean(found) && !missing, true, "hidden: true queries", impl);
      return n + rows;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "a11y/user-event-flow",
    group: "a11y",
    desc: "@testing-library/user-event v14 (delay: null) on the React form+todo app: type() 3 fields x 20 chars, " +
      "click() x30, tab() x10, selectOptions, clear",
    prepare: ctx => loadTestingLibrary(ctx, { react: true }),
    setup(ctx, shared) {
      const dom = freshDom(ctx, "<!DOCTYPE html><html><head><title>App</title></head><body></body></html>", { url: "http://localhost/" });
      installGlobals(dom.window);
      const { RTL, React, apps } = shared;
      RTL.render(React.createElement(apps.TodoForm));
      return { dom, ...shared, impl: ctx.impl };
    },
    async run({ dom, RTL, userEvent, impl }) {
      const { document } = dom.window;
      const screen = RTL.within(document.body);
      const user = userEvent.setup({ delay: null, document });
      const first = screen.getByRole("textbox", { name: "First name" });
      const last = screen.getByRole("textbox", { name: "Last name" });
      const email = screen.getByRole("textbox", { name: "Email" });
      await user.type(first, "Ada Augusta Lovelace");
      await user.type(last, "Byron King Lovelace!");
      await user.type(email, "ada@analytical.engine");
      check(`${first.value}|${last.value}|${email.value}`,
        "Ada Augusta Lovelace|Byron King Lovelace!|ada@analytical.engine", "typed values", impl);
      const boxes = screen.getAllByRole("checkbox").slice(1);
      for (let i = 0; i < 30; i++) {
        await user.click(boxes[i]);
      }
      await user.click(first);
      for (let i = 0; i < 10; i++) {
        await user.tab();
      }
      check(document.activeElement.id, "extra-4", "focus after 10 tabs", impl);
      const country = screen.getByRole("combobox", { name: "Country" });
      await user.selectOptions(country, "jp");
      await user.clear(first);
      check(`${country.value}|${first.value}`, "jp|", "select/clear", impl);
      // 40 todos, every 5th starts done; 30 clicks toggle the first 30
      return check(screen.getByText(/remaining$/u).textContent, "14 remaining", "remaining count", impl);
    },
    teardown(st) {
      st.RTL.cleanup();
      return st.dom.close();
    }
  }
];
