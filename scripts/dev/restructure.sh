#!/usr/bin/env bash
# Moves the repository from jsdom's layout to rsdom's, drops upstream-only files, and rewrites every path that
# refers to the old layout:
#
#   lib/        -> src/              (src/api.js, src/jsdom/..., src/generated/...)
#   native/     -> src/native/       (the Cargo crate; the addon is built to src/native/jsdom-native.node)
#   test/       -> tests/            (including the WPT submodule at tests/web-platform-tests/tests)
#   bench-rs/   -> bench/
#   README.md   -> docs/jsdom-api.md (upstream's API documentation)
#   removed:       benchmark/, MAINTAINERS.md, logo.svg, Changelog.md, .npmignore (package.json "files" instead),
#                  scripts/verify-tuwpts-in-browser.js, .github/ISSUE_TEMPLATE/, .github/workflows/publish.yml
#   renamed:       .github/workflows/jsdom-ci.yml -> ci.yml (now also builds the native addon)
#   package.json:  name rsdom, version 0.1.0, rsdom repository, "files" whitelist, no jsdom maintainers, and no
#                  scripts/devDependencies that only served removed files; package-lock.json is re-resolved
#                  with `npm install --package-lock-only` (node_modules is not touched).
#
# Usage: scripts/dev/restructure.sh [--extras-from <ref>]
#
#   --extras-from <ref>  also check out the rsdom-authored files (README.md, Contributing.md, tests/README.md,
#                        bench/report.js) from <ref>, e.g. the branch that first applied this restructure.
#
# Safe to re-run: moves and removals are skipped once done, and every rewrite only matches old-layout text.
# Untracked files inside moved directories (native/target, the built .node, bench-rs/node_modules, ...) move with
# them. Changes are staged (only the paths this script touched); nothing is committed.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

extras_ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --extras-from) extras_ref="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "restructure: unknown argument $1" >&2; exit 2 ;;
  esac
done

die() { echo "restructure: $*" >&2; exit 1; }
tracked() { [ -n "$(git ls-files -- "$1")" ]; }

old_layout=0
new_layout=0
for d in lib native test bench-rs; do
  if [ -d "$d" ]; then old_layout=1; fi
done
if [ -d src/jsdom ] && [ -d src/native ] && [ -d tests ] && [ -d bench ]; then new_layout=1; fi

if [ "$new_layout" = 1 ] && [ "$old_layout" = 0 ]; then
  echo "restructure: layout already applied; re-checking removals and path rewrites only"
else
  for d in lib native test bench-rs; do
    [ -d "$d" ] || die "expected $d/ (tree is neither the old nor the new layout)"
  done
  for d in src tests bench; do
    if [ -e "$d" ]; then die "$d already exists; refusing to merge directories (partially applied?)"; fi
  done
  git diff --cached --quiet || die "the index has staged changes; commit or unstage them first"

  # --- WPT submodule --------------------------------------------------------------------------------------------
  # In a normal clone, `git mv` moves a submodule inside a moved directory correctly (gitlink, .gitmodules path,
  # the submodule's core.worktree). Dev worktrees here instead have a symlink (to the main checkout's WPT checkout)
  # at the gitlink path, with skip-worktree set. `git mv` would follow that symlink and rewrite the *main checkout's*
  # submodule config, so move the gitlink by hand: drop it from the index, move the tree, re-add it at the new path.
  sub_old="test/web-platform-tests/tests"
  sub_new="tests/web-platform-tests/tests"
  sub_name="$(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' |
    awk -v p="$sub_old" '$2 == p { sub(/^submodule\./, "", $1); sub(/\.path$/, "", $1); print $1 }')"
  [ -n "$sub_name" ] || die ".gitmodules has no submodule at $sub_old"
  sub_link=""
  if [ -L "$sub_old" ]; then
    read -r sub_mode sub_sha _ < <(git ls-files -s -- "$sub_old")
    [ "$sub_mode" = 160000 ] || die "$sub_old is not a gitlink in the index"
    sub_flag="$(git ls-files -v -- "$sub_old" | cut -c1)"
    sub_link="$(readlink "$sub_old")"
    git update-index --no-skip-worktree -- "$sub_old"
    git update-index --force-remove -- "$sub_old"
    rm "$sub_old"
  fi

  # --- moves ----------------------------------------------------------------------------------------------------
  git mv lib src
  git mv native src/native
  git mv test tests
  git mv bench-rs bench

  if [ -n "$sub_link" ]; then
    git update-index --add --cacheinfo "160000,$sub_sha,$sub_new"
    ln -s "$sub_link" "$sub_new"
    if [ "$sub_flag" = S ]; then
      git update-index --skip-worktree -- "$sub_new"
    fi
  fi
  # `git mv` already did this in the normal-clone case; the submodule keeps its name (and so its .git/modules dir).
  git config -f .gitmodules "submodule.$sub_name.path" "$sub_new"
  git add .gitmodules
fi

# --- upstream-only files ------------------------------------------------------------------------------------------
if tracked README.md && ! tracked docs/jsdom-api.md; then
  mkdir -p docs
  git mv README.md docs/jsdom-api.md
fi
if tracked .github/workflows/jsdom-ci.yml && ! tracked .github/workflows/ci.yml; then
  git mv .github/workflows/jsdom-ci.yml .github/workflows/ci.yml
fi
for p in benchmark MAINTAINERS.md logo.svg Changelog.md .npmignore scripts/verify-tuwpts-in-browser.js \
         .github/ISSUE_TEMPLATE .github/workflows/publish.yml; do
  if tracked "$p"; then
    git rm -r -q -- "$p"
    echo "restructure: removed $p"
  fi
done

# --- path rewrites ------------------------------------------------------------------------------------------------
rewrite_out="$(mktemp)"
trap 'rm -f "$rewrite_out"' EXIT
node - > "$rewrite_out" <<'NODE'
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter(Boolean)
  .filter(f => !f.startsWith("tests/web-platform-tests/tests") && !f.startsWith("src/native/vendor/") &&
    !f.startsWith("tests/web-platform-tests/to-upstream/") && !f.startsWith("tests/to-port-to-wpts/jquery-fixtures/"))
  .filter(f => {
    try {
      return fs.lstatSync(f).isFile();
    } catch {
      return false;
    }
  });

// A path segment at a word boundary that is not part of a longer path (so `undici/lib/x` or `./lib/impls.js` stay).
const B = String.raw`(?<![\w./@-])`;
const re = s => new RegExp(s, "g");
const docRules = [
  [re(`${B}lib/`), "src/"],
  [re(`${B}test/`), "tests/"],
  [re(`${B}native/`), "src/native/"],
  [re(`${B}bench-rs\\b`), "bench"]
];
const requireLib = [re(String.raw`((?:\.\./)+)lib/`), "$1src/"];
const requireTest = [re(String.raw`((?:\.\./)+)test/`), "$1tests/"];

function packageJson(text) {
  const pkg = JSON.parse(text);
  const out = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "maintainers") {
      continue;
    }
    if (key === "main") {
      out.files = ["src/", "!src/native/", "!src/**/*.webidl", "LICENSE", "LICENSE.txt", "README.md"];
    }
    out[key] = value;
  }
  Object.assign(out, {
    name: "rsdom",
    version: "0.1.0",
    description: "A drop-in, API-compatible fork of jsdom with a Rust core for its hot paths",
    repository: { type: "git", url: "git+https://github.com/sagiereder/rsdom.git" },
    main: "./src/api.js"
  });
  if (!out.files) {
    out.files = ["src/", "!src/native/", "!src/**/*.webidl", "LICENSE", "LICENSE.txt", "README.md"];
  }
  for (const s of ["benchmark", "benchmark:compare", "test:tuwpt:browser"]) {
    delete out.scripts[s];
  }
  for (const [name, cmd] of Object.entries(out.scripts)) {
    out.scripts[name] = cmd
      .replace(/mocha test\//g, "mocha tests/")
      .replace(/\.\/test\/web-platform-tests/g, "./tests/web-platform-tests")
      .replace(/cd test\/web-platform-tests/g, "cd tests/web-platform-tests");
  }
  // only used by the removed benchmark/ and scripts/verify-tuwpts-in-browser.js
  delete out.devDependencies.tinybench;
  delete out.devDependencies.opener;
  return `${JSON.stringify(out, null, 2)}\n`;
}

// [file predicate, rules]; a rule is [RegExp | exact string, replacement] or a text => text function. Every rule
// must be a no-op on its own output so that re-running is harmless.
const RULES = [
  [f => f === "package.json", [packageJson]],
  [f => f === ".gitignore", [[re("(^|\\n)lib/"), "$1src/"], [re("(^|\\n)test/"), "$1tests/"]]],
  [f => f === "eslint.config.mjs", [
    [re("\"lib/"), "\"src/"],
    [re("Use lib/"), "Use src/"],
    [re("\"test/"), "\"tests/"],
    [/\n\s*"benchmark\/[^"\n]*",/g, ""],
    ["\"bench-rs/**\"", "\"bench/**\""]
  ]],
  [f => f === ".github/workflows/ci.yml", [
    [re(String.raw`\./test/`), "./tests/"],
    text => (text.includes("src/native/build.js") ?
      text :
      text.replace(/^(\s*)- name: Run tests\n/gm, "$1- name: Build native addon\n$1  run: node src/native/build.js\n$&"))
  ]],
  [f => f === "scripts/dev/test.js", [
    [re(String.raw`\^native\\/`), "^src\\/native\\/"],
    [re(String.raw`\^lib\\/`), "^src\\/"],
    [re(String.raw`\^test\\/`), "^tests\\/"],
    [re(String.raw`\^\(lib\|native\)\\/`), "^src\\/"],
    [re("\"test/"), "\"tests/"]
  ]],
  [f => f === "scripts/dev/run-wpt-shard.js", [[re(`${B}test/web-platform-tests`), "tests/web-platform-tests"]]],
  [f => /^scripts\/.*\.(js|mjs)$/.test(f), [requireLib, requireTest]],
  [f => /^tests\/.*\.(js|mjs)$/.test(f), [requireLib]],
  [f => f === "src/jsdom/native.js", [
    ["\"../../native/jsdom-native.node\"", "\"../native/jsdom-native.node\""],
    ["(native/)", "(src/native/)"]
  ]],
  [f => f === "src/native/build.js", [["copies it to native/", "copies it to src/native/"]]],
  [f => /^src\/.*\.(js|rs)$/.test(f), [
    [re(`${B}native/(src|vendor)/`), "src/native/$1/"],
    [re(`${B}lib/(jsdom|generated|api\\.js)`), "src/$1"]
  ]],
  [f => f === "bench/lib/impls.js", [
    [re("\"lib/"), "\"src/"],
    ["path.join(REPO_ROOT, \"lib\")", "path.join(REPO_ROOT, \"src\")"]
  ]],
  [f => f === "bench/profile.js", [
    [
      "rest.startsWith(\"jsdom-upstream/\") ? rest.slice(\"jsdom-upstream/\".length) : rest",
      "rest.startsWith(\"jsdom-upstream/lib/\") ? `src/${rest.slice(\"jsdom-upstream/lib/\".length)}` : rest"
    ],
    ["present it like the fork's lib/", "present it like the fork's src/"],
    ...docRules
  ]],
  [f => f === "bench/package.json" || f === "bench/package-lock.json", [[re("jsdom-bench-rs"), "rsdom-bench"]]],
  [f => f === "docs/jsdom-api.md", [[/\n\s*<img [^>]*src="logo\.svg"[^>]*>(<br>)?/, ""]]],
  [f => /\.md$/.test(f) && f !== "docs/jsdom-api.md" && f !== "README.md", docRules]
];

// Longer paths can push a `//` comment past the 120-column lint limit: move its overflowing words onto the next
// line, joining that line when it continues the same comment.
const MAX_LEN = 120;
function reflowComments(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*\/\/ )(.*)$/.exec(lines[i]);
    if (!m || lines[i].length <= MAX_LEN) {
      continue;
    }
    const words = m[2].split(" ");
    const moved = [];
    while (words.length > 1 && (m[1] + words.join(" ")).length > MAX_LEN) {
      moved.unshift(words.pop());
    }
    lines[i] = m[1] + words.join(" ");
    const next = lines[i + 1] === undefined ? null : /^(\s*\/\/ )(\S.*)$/.exec(lines[i + 1]);
    if (next && next[1] === m[1]) {
      lines[i + 1] = m[1] + moved.join(" ") + " " + next[2];
    } else {
      lines.splice(i + 1, 0, m[1] + moved.join(" "));
    }
  }
  return lines.join("\n");
}

const changed = [];
for (const f of files) {
  const rules = RULES.filter(([pred]) => pred(f)).flatMap(([, r]) => r);
  if (!rules.length) {
    continue;
  }
  const before = fs.readFileSync(f, "utf8");
  let text = before;
  for (const rule of rules) {
    if (typeof rule === "function") {
      text = rule(text);
    } else {
      const [from, to] = rule;
      text = typeof from === "string" ? text.split(from).join(to) : text.replace(from, to);
    }
  }
  if (text !== before && /\.(js|mjs)$/.test(f)) {
    text = reflowComments(text);
  }
  if (text !== before) {
    fs.writeFileSync(f, text);
    changed.push(f);
  }
}

// Report old-layout references that no rule handled, so new ones are noticed.
const leftovers = [];
for (const f of files) {
  if (!/\.(js|mjs|json|ya?ml|sh)$/.test(f) || /(^|\/)package-lock\.json$|wpt-manifest\.json$/.test(f) ||
      f === "scripts/dev/restructure.sh") {
    continue;
  }
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/(?:\.\.\/)+(?:lib|test|native)\b|["'`](?:lib|test|native|bench-rs|benchmark)\//g)) {
    // bench/ has its own lib/ dir; src/jsdom/native.js is the addon loader
    if (!(f.startsWith("bench/") && m[0] === "../lib") && !(f.startsWith("src/") && /native$/.test(m[0]))) {
      leftovers.push(`${f}: ${m[0]}`);
    }
  }
}
if (leftovers.length) {
  process.stderr.write(`restructure: possible old-layout references left (check these):\n  ${leftovers.join("\n  ")}\n`);
}
process.stdout.write(changed.join("\n"));
NODE
changed="$(cat "$rewrite_out")"

if [ -n "$changed" ]; then
  printf '%s\n' "$changed" | tr '\n' '\0' | xargs -0 git add --
  echo "restructure: rewrote paths in $(printf '%s\n' "$changed" | wc -l | tr -d ' ') file(s):"
  printf '  %s\n' $changed
else
  echo "restructure: no path rewrites needed"
fi

# Re-resolve the lockfile for the new name/version and the dropped devDependencies (node_modules is not touched).
if printf '%s\n' "$changed" | grep -qx package.json; then
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error
  git add package-lock.json
  echo "restructure: updated package-lock.json"
fi

if [ -n "$extras_ref" ]; then
  for f in README.md Contributing.md tests/README.md bench/report.js; do
    if git cat-file -e "$extras_ref:$f" 2>/dev/null; then
      git checkout "$extras_ref" -- "$f"
    else
      echo "restructure: $extras_ref has no $f; skipped" >&2
    fi
  done
fi
[ -e README.md ] || echo "restructure: no README.md yet (pass --extras-from <ref> to take rsdom's)" >&2
echo "restructure: done; review with 'git status' and commit (the changes are staged)"
