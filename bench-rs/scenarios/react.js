"use strict";
// React scenarios. React/react-dom are loaded once per process (after installing a bootstrap window's globals,
// which react-dom needs at module load); each iteration then gets a fresh JSDOM whose globals are installed
// before rendering.
const { freshDom, installGlobals } = require("../lib/common.js");
const { makeApps } = require("./react-apps.js");

function loadReact({ JSDOM }, { rtl = false } = {}) {
  const boot = freshDom(JSDOM, "<!DOCTYPE html><html><head></head><body></body></html>", { url: "http://localhost/" });
  installGlobals(boot.window);
  const React = require("react");
  const ReactDOMClient = require("react-dom/client");
  const shared = { React, ReactDOMClient, apps: makeApps(React) };
  if (rtl) {
    shared.RTL = require("@testing-library/react");
  }
  return shared;
}

function freshWindow(JSDOM) {
  const dom = freshDom(JSDOM, "<!DOCTYPE html><html><head><title>App</title></head><body></body></html>", { url: "http://localhost/" });
  installGlobals(dom.window);
  return dom;
}

async function renderDashboard({ JSDOM }, shared) {
  const dom = freshWindow(JSDOM);
  const { React, ReactDOMClient, apps } = shared;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  return { dom, root, container, React, apps };
}

async function closeDashboard(st) {
  if (st.root) {
    await st.React.act(() => st.root.unmount());
  }
  st.dom.window.close();
}

module.exports = [
  {
    name: "react/render-dashboard",
    group: "react",
    desc: "createRoot + act(render) of a ~3k-element dashboard (header/nav, sidebar, stat cards, 250-row table, form, feed)",
    prepare: ctx => loadReact(ctx),
    setup: renderDashboard,
    async run(st) {
      await st.React.act(() => st.root.render(st.React.createElement(st.apps.Dashboard)));
      st.count = st.container.getElementsByTagName("*").length;
    },
    teardown: closeDashboard
  },
  {
    name: "react/updates",
    group: "react",
    desc: "~50 state updates on the rendered dashboard: sort, filter, theme toggle, row selection, show/hide feed",
    prepare: ctx => loadReact(ctx),
    async setup(ctx, shared) {
      const st = await renderDashboard(ctx, shared);
      await st.React.act(() => st.root.render(st.React.createElement(st.apps.Dashboard)));
      return st;
    },
    async run(st) {
      const { act } = st.React;
      const c = () => st.apps.getController();
      for (let i = 0; i < 4; i++) {
        await act(() => c().setSortDir(d => -d));
      }
      for (const f of ["1", "12", "", "admin", "User 2", ""]) {
        await act(() => c().setFilter(f));
      }
      for (let i = 0; i < 4; i++) {
        await act(() => c().setTheme(t => (t === "dark" ? "light" : "dark")));
      }
      for (let i = 0; i < 30; i++) {
        await act(() => c().onSelect(i * 7));
      }
      for (let i = 0; i < 4; i++) {
        await act(() => c().setShowFeed(s => !s));
      }
    },
    teardown: closeDashboard
  },
  {
    name: "react/unmount",
    group: "react",
    desc: "act(root.unmount()) of 8 rendered dashboards (~33k elements total)",
    prepare: ctx => loadReact(ctx),
    async setup({ JSDOM }, { React, ReactDOMClient, apps }) {
      const dom = freshWindow(JSDOM);
      const roots = [];
      for (let i = 0; i < 8; i++) {
        const container = dom.window.document.createElement("div");
        dom.window.document.body.appendChild(container);
        const root = ReactDOMClient.createRoot(container);
        await React.act(() => root.render(React.createElement(apps.Dashboard)));
        roots.push(root);
      }
      return { dom, roots, React };
    },
    async run(st) {
      await st.React.act(() => {
        for (const root of st.roots) {
          root.unmount();
        }
      });
    },
    teardown: st => st.dom.window.close()
  },
  {
    name: "react/testing-library-form",
    group: "react",
    desc: "@testing-library/react: render form+todo app, getByRole/getByText/getAllByRole queries, fireEvent typing + clicks",
    prepare: ctx => loadReact(ctx, { rtl: true }),
    setup({ JSDOM }, shared) {
      return { dom: freshWindow(JSDOM), ...shared };
    },
    run(st) {
      const { RTL, React, apps } = st;
      const { render, fireEvent, within } = RTL;
      render(React.createElement(apps.TodoForm));
      // equivalent of `screen`, bound to this iteration's document (screen binds to the document at load time)
      const screen = within(st.dom.window.document.body);

      const type = (el, text) => {
        for (let i = 1; i <= text.length; i++) {
          fireEvent.change(el, { target: { value: text.slice(0, i) } });
        }
      };
      type(screen.getByRole("textbox", { name: "First name" }), "Ada");
      type(screen.getByRole("textbox", { name: "Last name" }), "Lovelace");
      type(screen.getByRole("textbox", { name: "Email" }), "ada@x.io");
      type(screen.getByLabelText("Bio"), "Mathematician");
      fireEvent.change(screen.getByRole("combobox", { name: "Country" }), { target: { value: "il" } });
      fireEvent.click(screen.getByRole("checkbox", { name: "Subscribe to newsletter" }));

      for (let i = 0; i < 5; i++) {
        type(screen.getByLabelText("New task"), `New ${i}`);
        fireEvent.click(screen.getByRole("button", { name: "Add task" }));
      }
      const boxes = screen.getAllByRole("checkbox");
      for (let i = 2; i < boxes.length; i += 4) {
        fireEvent.click(boxes[i]);
      }
      screen.getByText("Existing task 7");
      screen.getByText("New 3");
      fireEvent.click(screen.getByRole("button", { name: "Remove Existing task 3" }));
      const items = screen.getAllByRole("listitem");
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      screen.getByRole("status");
      screen.getByText(/remaining$/u);
      return items.length;
    },
    teardown(st) {
      st.RTL.cleanup();
      st.dom.window.close();
    }
  }
];
