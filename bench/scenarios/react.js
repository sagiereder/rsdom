"use strict";
// React scenarios. React/react-dom are loaded once per process (after installing a bootstrap window's globals,
// which react-dom needs at module load); each iteration then gets a fresh JSDOM whose globals are installed
// before rendering.
const { freshDom, installGlobals } = require("../lib/common.js");
const { makeApps } = require("./react-apps.js");

// `prod` loads React's production builds. They have no `act()`, so updates are flushed with `flushSync()` instead,
// which renders synchronously; none of the benchmark apps use passive effects.
function loadReact({ JSDOM }, { rtl = false, prod = false } = {}) {
  if (prod) {
    process.env.NODE_ENV = "production";
  }
  const boot = freshDom(JSDOM, "<!DOCTYPE html><html><head></head><body></body></html>", { url: "http://localhost/" });
  installGlobals(boot.window);
  const React = require("react");
  const ReactDOM = require("react-dom");
  const ReactDOMClient = require("react-dom/client");
  const act = prod ?
    fn => {
      ReactDOM.flushSync(fn);
    } :
    fn => React.act(fn);
  const shared = { React, ReactDOM, ReactDOMClient, act, apps: makeApps(React, ReactDOM) };
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

function renderDashboard({ JSDOM }, shared) {
  const dom = freshWindow(JSDOM);
  const { React, ReactDOMClient, apps, act } = shared;
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  return { dom, root, container, React, apps, act };
}

async function closeDashboard(st) {
  if (st.root) {
    await st.act(() => st.root.unmount());
  }
  st.dom.window.close();
}

// Sets a form control's value the way a user edit would (through the prototype setter, bypassing React's value
// tracker) and fires the input event React listens to.
async function typeInto(window, el, text, act) {
  const proto = el.localName === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value").set;
  for (let i = 1; i <= text.length; i++) {
    await act(() => {
      setValue.call(el, text.slice(0, i));
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
}

function dashboardScenarios(prefix, prod) {
  const prepare = ctx => loadReact(ctx, { prod });
  const label = prod ? " (React production build)" : "";
  return [
    {
      name: `${prefix}/render-dashboard`,
      group: prefix,
      desc: `createRoot + render of a ~3k-element dashboard (header/nav, sidebar, stat cards, 250-row table, form, feed)${label}`,
      prepare,
      setup: renderDashboard,
      async run(st) {
        await st.act(() => st.root.render(st.React.createElement(st.apps.Dashboard)));
        st.count = st.container.getElementsByTagName("*").length;
      },
      teardown: closeDashboard
    },
    {
      name: `${prefix}/updates`,
      group: prefix,
      desc: `~50 state updates on the rendered dashboard: sort, filter, theme toggle, row selection, show/hide feed${label}`,
      prepare,
      async setup(ctx, shared) {
        const st = renderDashboard(ctx, shared);
        await st.act(() => st.root.render(st.React.createElement(st.apps.Dashboard)));
        return st;
      },
      async run(st) {
        const { act } = st;
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
      name: `${prefix}/unmount`,
      group: prefix,
      desc: `root.unmount() of 8 rendered dashboards (~33k elements total)${label}`,
      prepare,
      async setup({ JSDOM }, { React, ReactDOMClient, apps, act }) {
        const dom = freshWindow(JSDOM);
        const roots = [];
        for (let i = 0; i < 8; i++) {
          const container = dom.window.document.createElement("div");
          dom.window.document.body.appendChild(container);
          const root = ReactDOMClient.createRoot(container);
          await act(() => root.render(React.createElement(apps.Dashboard)));
          roots.push(root);
        }
        return { dom, roots, act };
      },
      async run(st) {
        await st.act(() => {
          for (const root of st.roots) {
            root.unmount();
          }
        });
      },
      teardown: st => st.dom.window.close()
    },
    {
      name: `${prefix}/complex-app`,
      group: prefix,
      desc: "mount a 2000x8 data grid + 40-field form page, sort 4x, filter 4x, type into 3 fields, open/close a " +
        `20-field portal modal 5x, unmount${label}`,
      prepare,
      setup: renderDashboard,
      async run(st) {
        const { act, apps, root, dom } = st;
        const { document } = dom.window;
        await act(() => root.render(st.React.createElement(apps.ComplexApp)));
        const c = () => apps.getComplexController();
        for (const key of ["amount", "amount", "city", "name"]) {
          await act(() => c().onSort(key));
        }
        for (const f of ["1", "19", "Haifa", ""]) {
          await act(() => c().setFilter(f));
        }
        for (const id of ["ff-f0", "ff-f1", "ff-f4"]) {
          await typeInto(dom.window, document.getElementById(id), "hello world", act);
        }
        for (let i = 0; i < 5; i++) {
          await act(() => c().setModalOpen(true));
          await act(() => c().setModalOpen(false));
        }
        await act(() => root.unmount());
        st.root = null;
      },
      teardown: closeDashboard
    }
  ];
}

module.exports = [
  ...dashboardScenarios("react", false),
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
  },
  ...dashboardScenarios("react-prod", true)
];
