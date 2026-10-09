"use strict";
// React component trees used by the React scenarios. Plain React.createElement, no JSX.

function makeApps(React) {
  const h = React.createElement;
  const { useState, useMemo, useCallback, memo } = React;

  // ---------- Dashboard ----------
  const NAV = Array.from({ length: 12 }, (_, i) => `Section ${i}`);
  const MENU = Array.from({ length: 30 }, (_, i) => ({ id: i, label: `Menu item ${i}`, count: (i * 37) % 100 }));
  const STATS = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `Metric ${i}`, value: (i * 7919) % 10000, delta: ((i * 13) % 21) - 10 }));
  const ROWS = Array.from({ length: 250 }, (_, i) => ({
    id: i,
    name: `User ${i}`,
    email: `user${i}@example.com`,
    role: ["admin", "editor", "viewer"][i % 3],
    score: (i * 7331) % 1000,
    active: i % 4 !== 0
  }));

  const Icon = ({ name }) => h("svg", { className: `icon icon-${name}`, width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true },
    h("path", { d: "M0 0h16v16H0z", fill: "currentColor" }));

  const Header = ({ theme, onToggleTheme }) => h("header", { className: "app-header", style: { display: "flex", alignItems: "center", padding: "0 16px", height: 56, background: theme === "dark" ? "#111" : "#fff", borderBottom: "1px solid #ddd" } },
    h("h1", { className: "logo", style: { fontSize: 20, margin: 0 } }, "Dashboard"),
    h("nav", { className: "top-nav", "aria-label": "Main" },
      h("ul", { className: "nav-list", style: { display: "flex", listStyle: "none", gap: 8 } },
        NAV.map((n, i) => h("li", { key: n, className: i === 0 ? "nav-item active" : "nav-item" },
          h("a", { href: `#/s/${i}`, className: "nav-link" }, h(Icon, { name: "nav" }), n))))),
    h("button", { type: "button", className: "theme-toggle", onClick: onToggleTheme }, theme === "dark" ? "Light mode" : "Dark mode"));

  const Sidebar = memo(({ selected }) => h("aside", { className: "sidebar", style: { width: 240, padding: 12, overflowY: "auto" } },
    h("ul", { className: "menu" }, MENU.map(m => h("li", { key: m.id, className: m.id === selected ? "menu-item selected" : "menu-item" },
      h("a", { href: `#/m/${m.id}`, title: m.label }, h(Icon, { name: "menu" }), h("span", { className: "menu-label" }, m.label),
        h("span", { className: "menu-count", style: { marginLeft: "auto", opacity: 0.6 } }, m.count)))))));

  const StatCard = ({ stat, theme }) => h("div", { className: `stat-card ${stat.delta >= 0 ? "up" : "down"}`, style: { padding: 16, borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.2)", background: theme === "dark" ? "#222" : "#fafafa", color: theme === "dark" ? "#eee" : "#222", minWidth: 160 } },
    h("div", { className: "stat-label", style: { fontSize: 12, textTransform: "uppercase" } }, stat.label),
    h("div", { className: "stat-value", style: { fontSize: 28, fontWeight: 600 } }, stat.value.toLocaleString("en-US")),
    h("div", { className: "stat-delta", style: { color: stat.delta >= 0 ? "green" : "red" } }, `${stat.delta >= 0 ? "+" : ""}${stat.delta}%`));

  const Row = memo(({ row, selected, onSelect }) => h("tr", { className: selected ? "row selected" : "row", "data-id": row.id },
    h("td", null, h("input", { type: "checkbox", checked: selected, onChange: () => onSelect(row.id), "aria-label": `Select ${row.name}` })),
    h("td", { className: "name" }, h("strong", null, row.name)),
    h("td", { className: "email" }, h("a", { href: `mailto:${row.email}` }, row.email)),
    h("td", { className: "role" }, h("span", { className: `badge badge-${row.role}`, style: { padding: "2px 6px", borderRadius: 4 } }, row.role)),
    h("td", { className: "score", style: { textAlign: "right" } }, row.score),
    h("td", { className: "status" }, row.active ? "Active" : "Inactive"),
    h("td", { className: "actions" },
      h("button", { type: "button", className: "btn btn-sm" }, "Edit"),
      h("button", { type: "button", className: "btn btn-sm danger" }, "Delete"))));

  const DataTable = ({ rows, selected, onSelect, sortDir, onSort }) => h("table", { className: "data-table", style: { width: "100%", borderCollapse: "collapse" } },
    h("thead", null, h("tr", null, ["", "Name", "Email", "Role", "Score", "Status", "Actions"].map(c =>
      h("th", { key: c, scope: "col", onClick: c === "Score" ? onSort : undefined }, c, c === "Score" ? (sortDir > 0 ? " ▲" : " ▼") : null)))),
    h("tbody", null, rows.map(r => h(Row, { key: r.id, row: r, selected: selected.has(r.id), onSelect }))));

  const SettingsForm = () => h("form", { className: "settings-form", onSubmit: e => e.preventDefault() },
    h("fieldset", null, h("legend", null, "Settings"),
      Array.from({ length: 16 }, (_, i) => h("div", { key: i, className: "form-row", style: { display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, marginBottom: 6 } },
        h("label", { htmlFor: `f${i}` }, `Field ${i}`),
        i % 4 === 0 ?
          h("select", { id: `f${i}`, defaultValue: "o2" }, Array.from({ length: 8 }, (_, j) => h("option", { key: j, value: `o${j}` }, `Option ${j}`))) :
          i % 4 === 1 ?
            h("textarea", { id: `f${i}`, rows: 2, defaultValue: `Text ${i}` }) :
            h("input", { id: `f${i}`, type: i % 4 === 2 ? "text" : "number", defaultValue: i, placeholder: `Enter ${i}` })))),
    h("button", { type: "submit", className: "btn primary" }, "Save"));

  const ActivityFeed = ({ items }) => h("ol", { className: "feed" }, items.map(it => h("li", { key: it, className: "feed-item" },
    h("img", { src: `/avatar/${it}.png`, alt: "", width: 24, height: 24 }),
    h("p", null, h("b", null, `User ${it}`), " did something ", h("time", { dateTime: "2024-01-01" }, `${it}m ago`)))));

  let controller = null;
  function Dashboard() {
    const [theme, setTheme] = useState("light");
    const [filter, setFilter] = useState("");
    const [sortDir, setSortDir] = useState(1);
    const [selected, setSelected] = useState(() => new Set());
    const [showFeed, setShowFeed] = useState(true);
    const onSelect = useCallback(id => setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    }), []);
    const onSort = useCallback(() => setSortDir(d => -d), []);
    controller = { setTheme, setFilter, setSortDir, setSelected, setShowFeed, onSelect };
    const rows = useMemo(() => {
      const f = filter ? ROWS.filter(r => r.name.includes(filter) || r.role.includes(filter)) : ROWS;
      return [...f].sort((a, b) => sortDir * (a.score - b.score));
    }, [filter, sortDir]);
    return h("div", { className: `app theme-${theme}` },
      h(Header, { theme, onToggleTheme: () => setTheme(t => (t === "dark" ? "light" : "dark")) }),
      h("div", { className: "layout", style: { display: "flex" } },
        h(Sidebar, { selected: 3 }),
        h("main", { className: "content", style: { flex: 1, padding: 16 } },
          h("section", { className: "stats", style: { display: "flex", flexWrap: "wrap", gap: 12 } }, STATS.map(s => h(StatCard, { key: s.id, stat: s, theme }))),
          h("section", { className: "table-section" },
            h("div", { className: "toolbar" },
              h("input", { type: "search", value: filter, onChange: e => setFilter(e.target.value), placeholder: "Filter users", "aria-label": "Filter" }),
              h("span", { className: "count" }, `${rows.length} users`)),
            h(DataTable, { rows, selected, onSelect, sortDir, onSort })),
          h(SettingsForm),
          showFeed ? h(ActivityFeed, { items: Array.from({ length: 60 }, (_, i) => i) }) : null)));
  }

  // ---------- Form-heavy app for @testing-library ----------
  function TodoForm() {
    const [todos, setTodos] = useState(() => Array.from({ length: 40 }, (_, i) => ({ id: i, text: `Existing task ${i}`, done: i % 5 === 0 })));
    const [draft, setDraft] = useState("");
    const [profile, setProfile] = useState({ first: "", last: "", email: "", bio: "", country: "us", newsletter: false });
    const [submitted, setSubmitted] = useState(null);
    const field = (key, label, props = {}) => h("div", { className: "field" },
      h("label", { htmlFor: `p-${key}` }, label),
      h("input", { id: `p-${key}`, value: profile[key], onChange: e => setProfile(p => ({ ...p, [key]: e.target.value })), ...props }));
    return h("div", { className: "todo-app" },
      h("h1", null, "Account & Tasks"),
      h("form", { "aria-label": "Profile", onSubmit: e => {
        e.preventDefault();
        setSubmitted({ ...profile });
      } },
      field("first", "First name"),
      field("last", "Last name"),
      field("email", "Email", { type: "email" }),
      h("div", { className: "field" }, h("label", { htmlFor: "p-bio" }, "Bio"),
        h("textarea", { id: "p-bio", value: profile.bio, onChange: e => setProfile(p => ({ ...p, bio: e.target.value })) })),
      h("div", { className: "field" }, h("label", { htmlFor: "p-country" }, "Country"),
        h("select", { id: "p-country", value: profile.country, onChange: e => setProfile(p => ({ ...p, country: e.target.value })) },
          ["us", "uk", "de", "fr", "il", "jp", "br", "in"].map(c => h("option", { key: c, value: c }, c.toUpperCase())))),
      h("div", { className: "field" }, h("label", null,
        h("input", { type: "checkbox", checked: profile.newsletter, onChange: e => setProfile(p => ({ ...p, newsletter: e.target.checked })) }),
        "Subscribe to newsletter")),
      Array.from({ length: 10 }, (_, i) => h("div", { key: i, className: "field" },
        h("label", { htmlFor: `extra-${i}` }, `Extra field ${i}`), h("input", { id: `extra-${i}`, defaultValue: "" }))),
      h("button", { type: "submit" }, "Save profile")),
      submitted ? h("p", { role: "status" }, `Saved ${submitted.first} ${submitted.last}`) : null,
      h("section", { "aria-label": "Tasks" },
        h("h2", null, "Tasks"),
        h("div", { className: "add-row" },
          h("label", { htmlFor: "new-todo" }, "New task"),
          h("input", { id: "new-todo", value: draft, onChange: e => setDraft(e.target.value) }),
          h("button", { type: "button", onClick: () => {
            if (draft) {
              setTodos(t => [...t, { id: t.length, text: draft, done: false }]);
              setDraft("");
            }
          } }, "Add task")),
        h("ul", null, todos.map(t => h("li", { key: t.id, className: t.done ? "done" : "" },
          h("label", null,
            h("input", { type: "checkbox", checked: t.done, onChange: () => setTodos(ts => ts.map(x => (x.id === t.id ? { ...x, done: !x.done } : x))) }),
            t.text),
          h("button", { type: "button", "aria-label": `Remove ${t.text}`, onClick: () => setTodos(ts => ts.filter(x => x.id !== t.id)) }, "×")))),
        h("p", null, `${todos.filter(t => !t.done).length} remaining`)));
  }

  return { Dashboard, TodoForm, getController: () => controller };
}

module.exports = { makeApps };
