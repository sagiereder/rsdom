#!/bin/bash
# One-time setup for npm trusted publishing (run by a maintainer, logged in with `npm login`, npm >= 11.10).
# npm only lets you add a trusted publisher to a package that already exists, so for every package that isn't on the
# registry yet this publishes an empty 0.0.0 placeholder, then links the package to sagiereder/rsdom's release.yml.
# After this, releases publish from CI with no token. Pass --dry-run to only print what would happen.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=sagiereder/rsdom
WORKFLOW=release.yml
DRY=${1:-}
NPM="npx -y npm@latest"

NAMES=(@rsdom/core @rsdom/jest @rsdom/vitest)
while read -r p; do NAMES+=("@rsdom/core-$p"); done < <(node -p "require('./scripts/release/platforms.js').map(p => p.name).join('\n')")

run() { echo "+ $*"; if [[ "$DRY" != --dry-run ]]; then "$@"; fi; }

for name in "${NAMES[@]}"; do
  if npm view "$name" version >/dev/null 2>&1; then
    echo "$name exists on npm"
  else
    dir=$(mktemp -d)
    cat > "$dir/package.json" <<JSON
{ "name": "$name", "version": "0.0.0", "description": "Placeholder; real releases are published from https://github.com/$REPO",
  "license": "MIT", "repository": { "type": "git", "url": "git+https://github.com/$REPO.git" } }
JSON
    echo "# $name"$'\n\n'"Placeholder release. See https://github.com/$REPO." > "$dir/README.md"
    run $NPM publish "$dir" --access public --tag placeholder
    rm -rf "$dir"
  fi
  if $NPM trust list "$name" 2>/dev/null | grep -q "$REPO"; then
    echo "$name already trusts $REPO"
  else
    run $NPM trust github "$name" --repo "$REPO" --file "$WORKFLOW" --allow-publish --yes
  fi
done
