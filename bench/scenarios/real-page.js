"use strict";
// A realistic large page: a deterministically generated GitHub-style repository page (~200KB): head metadata,
// header with octicon SVGs, repo tabs, a file grid, a rendered README (headings with anchors, nested lists,
// syntax-highlighted code, tables, blockquotes) and a sidebar. The markup is written in the exact form the HTML
// serializer produces, so serializing the parsed document must reproduce it byte for byte.
const { freshDom, rng, check } = require("../lib/common.js");

const WORDS = ("the of and to a in is it you that he was for on are with as his they be at one have this from or had " +
  "by hot word but what some we can out other were all there when up use your how said an each she which do their time " +
  "if will way about many then them write would like so these her long make thing see him two has look more day could go " +
  "come did number sound no most people my over know water than call first who may down side been now find").split(" ");

const OCTICONS = {
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Z",
  file: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Z",
  dir: "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z",
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  link: "m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Z"
};

function generatePage() {
  const rand = rng(2024);
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const words = n => Array.from({ length: n }, () => pick(WORDS)).join(" ");
  const icon = (name, cls = "") => `<svg aria-hidden="true" height="16" viewBox="0 0 16 16" version="1.1" width="16" ` +
    `data-view-component="true" class="octicon octicon-${name}${cls}"><path d="${OCTICONS[name]}"></path></svg>`;
  const para = () => {
    let p = "<p>";
    const n = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      const r = rand();
      if (r < 0.15) {
        p += `<code>${pick(WORDS)}()</code> `;
      } else if (r < 0.3) {
        p += `<a href="https://github.com/example/${pick(WORDS)}" rel="nofollow">${words(2)}</a> `;
      } else if (r < 0.4) {
        p += `<strong>${words(2)}</strong> `;
      } else if (r < 0.45) {
        p += `<em>${words(1)}</em> &amp; `;
      } else {
        p += `${words(6 + Math.floor(rand() * 8))}. `;
      }
    }
    return `${p.trimEnd()}</p>`;
  };
  const codeLine = () => {
    const k = pick(["const", "let", "function", "return", "import", "export", "await", "if"]);
    return `<span class="pl-k">${k}</span> <span class="pl-s1">${pick(WORDS)}</span> <span class="pl-c1">=</span> ` +
      `<span class="pl-en">${pick(WORDS)}</span>(<span class="pl-s"><span class="pl-pds">"</span>${words(2)}<span class="pl-pds">"</span></span>);`;
  };

  let h = "<!DOCTYPE html><html lang=\"en\" data-color-mode=\"auto\" data-light-theme=\"light\" data-dark-theme=\"dark\"><head>" +
    "<meta charset=\"utf-8\"><title>example/widgets: Widgets for the modern web</title>" +
    "<meta name=\"viewport\" content=\"width=device-width\"><meta name=\"description\" content=\"Widgets for the modern web\">";
  for (const [k, v] of [["og:title", "example/widgets"], ["og:type", "object"], ["og:url", "https://github.com/example/widgets"],
    ["og:description", "Widgets for the modern web"], ["twitter:card", "summary_large_image"], ["twitter:site", "@github"]]) {
    h += `<meta property="${k}" content="${v}">`;
  }
  for (let i = 0; i < 8; i++) {
    h += `<link crossorigin="anonymous" media="all" rel="stylesheet" href="https://github.githubassets.com/assets/css-${i}-${Math.floor(rand() * 1e8).toString(16)}.css">`;
  }
  h += "<script type=\"application/json\" id=\"client-env\">{\"locale\":\"en\",\"featureFlags\":[\"a\",\"b\",\"c\"]}</script>" +
    "<style>.anchor{float:left;margin-left:-20px}.markdown-body h2{border-bottom:1px solid #d0d7de}</style></head>";

  h += "<body class=\"logged-out env-production page-responsive\" style=\"word-wrap: break-word;\">" +
    "<div class=\"position-relative js-header-wrapper\"><a href=\"#start-of-content\" data-skip-target-assigned=\"false\" class=\"px-2 py-4 show-on-focus js-skip-to-content\">Skip to content</a>" +
    "<header class=\"HeaderMktg header-logged-out js-details-container js-header\" role=\"banner\"><div class=\"container-xl d-flex\">" +
    `<a class="mr-lg-8 color-fg-inherit" href="https://github.com/" aria-label="Homepage" data-analytics-event="{&quot;category&quot;:&quot;Marketing nav&quot;}">${icon("repo")}</a>` +
    "<nav aria-label=\"Global\" class=\"js-details-container\"><ul class=\"d-lg-flex list-style-none\">";
  for (const section of ["Product", "Solutions", "Resources", "Open Source", "Enterprise", "Pricing"]) {
    h += `<li class="HeaderMenu-item position-relative flex-wrap"><details class="HeaderMenu-details details-overlay"><summary class="HeaderMenu-link border-0">${section}</summary>` +
      "<div class=\"dropdown-menu\"><ul class=\"list-style-none f5\">";
    for (let i = 0; i < 6; i++) {
      h += `<li><a class="HeaderMenu-dropdown-link d-block no-underline" data-analytics-event="nav_${i}" href="/features/${section.toLowerCase().replace(/ /gu, "-")}/${i}">${icon(pick(["star", "file", "link"]), " color-fg-subtle mr-3")}<div><div class="h4">${words(2)}</div>${words(6)}</div></a></li>`;
    }
    h += "</ul></div></details></li>";
  }
  h += "</ul></nav><form class=\"search-form\" role=\"search\" aria-label=\"Site\" action=\"/search\" method=\"get\">" +
    "<input type=\"search\" name=\"q\" aria-label=\"Search GitHub\" placeholder=\"Search or jump to...\" autocomplete=\"off\">" +
    "<button type=\"submit\" class=\"btn\" hidden=\"\">Search</button></form></div></header></div>";

  h += "<div id=\"start-of-content\" class=\"show-on-focus\"></div><main id=\"js-repo-pjax-container\">" +
    "<div id=\"repository-container-header\" class=\"pt-3 hide-full-screen\" data-turbo-replace=\"\"><div class=\"d-flex flex-wrap px-lg-5\">" +
    `<div class="flex-auto min-width-0 width-fit">${icon("repo", " color-fg-muted mr-2")}<strong itemprop="name" class="mr-2 flex-self-stretch"><a data-pjax="#repo-content-pjax-container" href="/example/widgets">widgets</a></strong>` +
    "<span class=\"Label Label--secondary v-align-middle mr-1\">Public</span></div><ul class=\"pagehead-actions flex-shrink-0 d-none d-md-inline\">";
  for (const [label, n] of [["Notifications", 0], ["Fork", 1234], ["Star", 23456]]) {
    h += `<li><a href="/login?return_to=%2Fexample%2Fwidgets" rel="nofollow" data-hydro-click="${label}" aria-label="You must be signed in to ${label.toLowerCase()}" class="btn-sm btn">${icon("star", " mr-2")}${label}${n ? `<span id="repo-${label.toLowerCase()}-counter" class="Counter" title="${n.toLocaleString("en-US")}">${(n / 1000).toFixed(1)}k</span>` : ""}</a></li>`;
  }
  h += "</ul></div><nav data-pjax=\"#js-repo-pjax-container\" aria-label=\"Repository\" class=\"js-repo-nav js-sidenav-container-pjax js-responsive-underlinenav overflow-hidden UnderlineNav px-3\"><ul class=\"UnderlineNav-body list-style-none\">";
  ["Code", "Issues", "Pull requests", "Actions", "Projects", "Wiki", "Security", "Insights"].forEach((tab, i) => {
    h += `<li class="d-inline-flex"><a id="${tab.toLowerCase().replace(/ /gu, "-")}-tab" href="/example/widgets/${i ? tab.toLowerCase().replace(/ /gu, "-") : ""}" data-tab-item="i${i}${tab.toLowerCase()}-tab" class="UnderlineNav-item no-wrap js-responsive-underlinenav-item${i ? "" : " selected"}"${i ? "" : " aria-current=\"page\""} data-selected-links="repo_${tab.toLowerCase()}">${icon(pick(["file", "dir", "star"]), " UnderlineNav-octicon d-none d-sm-inline")}<span data-content="${tab}">${tab}</span>${i === 1 || i === 2 ? `<span class="Counter" title="${i * 117}">${i * 117}</span>` : ""}</a></li>`;
  });
  h += "</ul></nav></div>";

  // file browser grid
  h += "<div class=\"Layout Layout--flowRow-until-md\"><div class=\"Layout-main\"><div class=\"Box mb-3\"><div class=\"Box-header\"><div class=\"d-flex flex-items-center\">" +
    `<a class="Link--primary text-bold" href="/octocat">octocat</a> <span class="d-none d-sm-inline"><a class="Link--secondary" href="/example/widgets/commit/0a1b2c3">${words(5)}</a></span>` +
    "<relative-time datetime=\"2024-05-17T09:12:44Z\" class=\"no-wrap\">May 17, 2024</relative-time></div></div><div role=\"grid\" aria-labelledby=\"files\" class=\"Details-content--hidden-not-important js-navigation-container\">";
  for (let i = 0; i < 50; i++) {
    const dir = i < 12;
    const name = dir ? `${pick(WORDS)}-${i}` : `${pick(WORDS)}_${i}.${pick(["js", "ts", "md", "json", "yml"])}`;
    h += `<div role="row" class="Box-row Box-row--focus-gray py-2 d-flex position-relative js-navigation-item${i % 2 ? " navigation-focus" : ""}">` +
      `<div role="gridcell" class="mr-3 flex-shrink-0" style="width: 16px;">${icon(dir ? "dir" : "file", dir ? " hx_color-icon-directory" : " color-fg-muted")}</div>` +
      `<div role="rowheader" class="flex-auto min-width-0 col-md-2 mr-3"><span class="css-truncate css-truncate-target d-block width-fit"><a class="js-navigation-open Link--primary" title="${name}" data-turbo-frame="repo-content-turbo-frame" href="/example/widgets/${dir ? "tree" : "blob"}/main/${name}">${name}</a></span></div>` +
      `<div role="gridcell" class="flex-auto min-width-0 d-none d-md-block col-5 mr-3"><span class="css-truncate css-truncate-target d-block width-fit"><a data-pjax="true" title="${words(5)}" class="Link--secondary" href="/example/widgets/commit/${Math.floor(rand() * 1e12).toString(16)}">${words(4)}</a></span></div>` +
      `<div role="gridcell" class="color-fg-muted text-right" style="width: 100px;"><relative-time datetime="2024-0${1 + (i % 9)}-1${i % 10}T10:00:00Z" class="no-wrap">${1 + (i % 11)} months ago</relative-time></div></div>`;
  }
  h += "</div></div>";

  // README
  h += "<div id=\"readme\" class=\"Box md js-code-block-container js-code-nav-container js-tagsearch-file Box--responsive\" data-tagsearch-path=\"README.md\" data-tagsearch-lang=\"Markdown\">" +
    `<div class="Box-header d-flex border-bottom-0 flex-items-center flex-justify-between color-bg-default rounded-top-2"><h2 class="Box-title"><a href="#readme" data-view-component="true" class="Link--primary Link">README.md</a></h2></div>` +
    "<div data-target=\"readme-toc.content\" class=\"Box-body px-5 pb-5\"><article class=\"markdown-body entry-content container-lg\" itemprop=\"text\">" +
    "<h1 tabindex=\"-1\" dir=\"auto\"><a id=\"user-content-widgets\" class=\"anchor\" aria-hidden=\"true\" tabindex=\"-1\" href=\"#widgets\">" + icon("link") + "</a>Widgets</h1>";
  for (let s = 0; s < 38; s++) {
    const title = words(3);
    const slug = title.replace(/ /gu, "-");
    h += `<div class="markdown-heading" dir="auto"><h2 tabindex="-1" class="heading-element" dir="auto">${title}</h2><a id="user-content-${slug}-${s}" class="anchor" aria-label="Permalink: ${title}" href="#${slug}-${s}">${icon("link")}</a></div>`;
    h += para() + para();
    const kind = s % 5;
    if (kind === 0) {
      h += "<ul dir=\"auto\">";
      for (let i = 0; i < 6; i++) {
        h += `<li>${words(5)}${i % 3 === 1 ? `<ul dir="auto"><li><code>${pick(WORDS)}</code> ${words(4)}</li><li>${words(3)}</li></ul>` : ""}</li>`;
      }
      h += "</ul>";
    } else if (kind === 1) {
      h += "<div class=\"highlight highlight-source-js notranslate position-relative overflow-auto\" dir=\"auto\"><pre>";
      for (let i = 0; i < 12; i++) {
        h += `${codeLine()}\n`;
      }
      h += `</pre><div class="zeroclipboard-container"><clipboard-copy aria-label="Copy" class="ClipboardButton btn" data-copy-feedback="Copied!" tabindex="0" role="button">${icon("file", " js-clipboard-copy-icon")}</clipboard-copy></div></div>`;
    } else if (kind === 2) {
      h += "<markdown-accessiblity-table><table><thead><tr><th>Option</th><th>Type</th><th>Default</th><th>Description</th></tr></thead><tbody>";
      for (let i = 0; i < 8; i++) {
        h += `<tr><td><code>${pick(WORDS)}${i}</code></td><td><code>${pick(["string", "number", "boolean", "Function"])}</code></td><td><code>${pick(["null", "true", "0", "\"auto\""])}</code></td><td>${words(8)}</td></tr>`;
      }
      h += "</tbody></table></markdown-accessiblity-table>";
    } else if (kind === 3) {
      h += `<blockquote>${para()}</blockquote><ol dir="auto">`;
      for (let i = 0; i < 5; i++) {
        h += `<li><p>${words(7)}</p></li>`;
      }
      h += "</ol>";
    } else {
      h += `<p dir="auto"><a target="_blank" rel="noopener noreferrer" href="/example/widgets/blob/main/docs/img-${s}.png"><img src="/example/widgets/raw/main/docs/img-${s}.png" alt="${words(3)}" style="max-width: 100%;"></a></p>`;
    }
  }
  h += "</article></div></div></div>";

  // sidebar
  h += "<div class=\"Layout-sidebar\"><div class=\"BorderGrid about-margin\"><div class=\"BorderGrid-row\"><div class=\"BorderGrid-cell\"><h2 class=\"mb-3 h4\">About</h2>" +
    `<p class="f4 my-3">${words(9)}</p><div class="my-3 d-flex flex-items-center">${icon("link", " flex-shrink-0 mr-2")}<span class="flex-auto min-width-0 css-truncate css-truncate-target width-fit"><a title="https://widgets.example.dev" role="link" target="_blank" class="text-bold" rel="noopener noreferrer" href="https://widgets.example.dev">widgets.example.dev</a></span></div>` +
    "<h3 class=\"sr-only\">Topics</h3><div class=\"my-3\"><div class=\"f6\">";
  for (let i = 0; i < 14; i++) {
    const t = pick(WORDS);
    h += `<a href="/topics/${t}" title="Topic: ${t}" data-view-component="true" class="topic-tag topic-tag-link">${t}</a>`;
  }
  h += "</div></div></div></div><div class=\"BorderGrid-row\"><div class=\"BorderGrid-cell\"><h2 class=\"h4 mb-3\">Contributors</h2><ul class=\"list-style-none d-flex flex-wrap mb-n2\">";
  for (let i = 0; i < 24; i++) {
    h += `<li class="mb-2 mr-2"><a href="https://github.com/user${i}" data-hovercard-type="user" data-hovercard-url="/users/user${i}/hovercard" class=""><img src="https://avatars.githubusercontent.com/u/${1000 + i}?s=64&amp;v=4" alt="@user${i}" size="32" height="32" width="32" class="avatar circle"></a></li>`;
  }
  h += "</ul></div></div></div></div></div></main>";

  h += "<footer class=\"footer pt-8 pb-6 f6 color-fg-muted p-responsive\" role=\"contentinfo\"><h2 class=\"sr-only\">Footer</h2><nav aria-label=\"Footer\"><ul class=\"list-style-none d-flex flex-wrap\">";
  for (const l of ["Terms", "Privacy", "Security", "Status", "Docs", "Contact", "Manage cookies", "Do not share my personal information"]) {
    h += `<li class="mx-2"><a href="https://docs.github.com/site-policy/${l.toLowerCase().replace(/ /gu, "-")}" data-analytics-event="footer_${l}" class="Link--secondary Link">${l}</a></li>`;
  }
  h += "</ul></nav></footer><div id=\"ajax-error-message\" class=\"ajax-error-message flash flash-error\" hidden=\"\">" +
    "<button type=\"button\" class=\"flash-close js-ajax-error-dismiss\" aria-label=\"Dismiss error\"></button> You can't perform that action at this time.</div>" +
    "<template id=\"site-details-dialog\"><details class=\"details-reset details-overlay\"><summary role=\"button\" aria-label=\"Close dialog\"></summary></details></template>" +
    "</body></html>";
  return h;
}

// Real-world selectors from page scripts, browser extensions, scrapers and tests.
const SELECTORS = [
  "li", "a", "[aria-label]", "[class~=Link--primary]", "li:nth-child(2n+1)", "a[href^='/']", "a[href^='https://']",
  "a[href$='.md']", "[data-analytics-event]", "nav[aria-label='Repository'] a[aria-current='page']",
  ".markdown-body .markdown-heading > h2", "pre span.pl-k", "img[alt^='@']", "details > summary", "button:not([disabled])",
  "input[type=search]", "table tbody tr:nth-child(even) td", "ul ul li", "[role=row] [role=gridcell] a", "svg.octicon path",
  "h1, h2, h3", "[hidden]", ":is(h2, h3).heading-element", "meta[property^='og:']", "relative-time[datetime]",
  "a:not([href^='http'])", "p > code", "li:last-child", "div:empty", "li:has(> ul)", ".Box-row:not(.navigation-focus) .Link--secondary",
  "main #readme article.markdown-body > p:first-of-type", ".UnderlineNav-item.selected span[data-content]",
  "[data-hovercard-type='user'] > img.avatar", "*"
];

const PAGE_LENGTH = 195836;
const ELEMENT_COUNT = 3082;
const SELECTOR_TOTAL = { "default": "15630/340", "happy-dom": "15738/340" };

function withPage(ctx, { html }) {
  const dom = freshDom(ctx, html);
  return { dom, html, impl: ctx.impl };
}

module.exports = [
  {
    name: "parse/real-page",
    group: "parse",
    desc: "parse a generated ~200KB GitHub-style repository page as a full document (new JSDOM(html) / happy-dom)",
    prepare: () => ({ html: generatePage() }),
    setup: (ctx, { html }) => ({ createDom: ctx.createDom, html, impl: ctx.impl }),
    run(st) {
      check(st.html.length, PAGE_LENGTH, "generated page length", st.impl);
      st.dom = st.createDom(st.html);
      check(st.dom.window.document.getElementsByTagName("*").length, ELEMENT_COUNT, "element count", st.impl);
    },
    teardown: st => st.dom && st.dom.close()
  },
  {
    name: "parse/real-page-serialize",
    group: "parse",
    desc: "snapshot-test style: 25 rounds of a small edit (title, counter text, open <details>) followed by a " +
      "full-document serialize() and body.innerHTML of the ~200KB page; output must equal the expected markup exactly",
    prepare: () => ({ html: generatePage() }),
    setup: withPage,
    run({ dom, html, impl }) {
      const { document } = dom.window;
      const counter = document.getElementById("repo-star-counter");
      const details = document.querySelectorAll("details");
      check(dom.serialize() === html, true, "serialize() round-trips the page byte for byte", impl);
      let n = 0;
      const open = new Set();
      for (let i = 0; i < 25; i++) {
        document.title = `example/widgets (${i})`;
        counter.textContent = `${23 + i}.5k`;
        // toggle a disclosure: open on even rounds, close on odd ones
        const d = (i * 5) % details.length;
        details[d].open = i % 2 === 0;
        open[i % 2 === 0 ? "add" : "delete"](d);
        const out = dom.serialize();
        const body = document.body.innerHTML;
        const want = html
          .replace("<title>example/widgets: Widgets for the modern web</title>", `<title>example/widgets (${i})</title>`)
          .replace(">23.5k</span>", `>${23 + i}.5k</span>`);
        check(out.length - want.length, open.size * " open=\"\"".length, "serialized length delta", impl);
        check(out.includes(`<title>example/widgets (${i})</title>`) && body.includes(`>${23 + i}.5k</span>`), true, "edits serialized", impl);
        n += out.length + body.length;
      }
      return n;
    },
    teardown: st => st.dom.close()
  },
  {
    name: "parse/real-page-selectors",
    group: "parse",
    desc: `${SELECTORS.length} real-world selectors (attribute operators, :nth-child(2n+1), :has, :is, :not, combinators) ` +
      "via querySelectorAll on the parsed page (x3), plus closest() from every link",
    caveats: {
      "happy-dom": "wrong results: div:empty matches 37 elements instead of 1 (text-only divs count as empty)"
    },
    prepare: () => ({ html: generatePage() }),
    setup: withPage,
    run({ dom, impl }) {
      const { document } = dom.window;
      let total = 0;
      for (let rep = 0; rep < 3; rep++) {
        for (const sel of SELECTORS) {
          total += document.querySelectorAll(sel).length;
        }
      }
      let closest = 0;
      for (const a of document.getElementsByTagName("a")) {
        closest += (a.closest("li") ? 1 : 0) + (a.closest("[role=row]") ? 1 : 0) + (a.closest("article, nav") ? 1 : 0);
      }
      check(`${total}/${closest}`, SELECTOR_TOTAL, "matched elements", impl);
      return total;
    },
    teardown: st => st.dom.close()
  }
];
