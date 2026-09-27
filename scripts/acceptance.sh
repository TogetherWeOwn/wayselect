#!/bin/sh
# TOG-4800 release acceptance check: clean checkout -> install -> test -> demo.
#
# Usage:
#   scripts/acceptance.sh [ref]        # verify the current tree, or a git ref
#   npm run acceptance                 # same, for the current tree
#
# With a ref argument the script clones the repo into a temp dir, checks out
# the ref, and runs everything there -- that is the release gate. Without an
# argument it verifies the current working tree in place (developer
# pre-check). No network access is expected: every test runs under the
# no-network guard (wired into `npm test`); install only fetches the pinned
# dev dependencies (ajv for schema validation, escape-html for the preview).
#
# TOG-5265 port: the single-command CLI takes selection inputs via a --request
# JSON file, so the edge spot-checks write temp request files instead of the
# old `select --operation ...` flags.
set -eu

REF="${1:-}"
WORKDIR=""

if [ -n "$REF" ]; then
  WORKDIR="$(mktemp -d wayselect-acceptance-XXXXXX)"
  trap 'rm -rf "$WORKDIR"' EXIT INT TERM
  git clone --quiet . "$WORKDIR/repo"
  cd "$WORKDIR/repo"
  git checkout --quiet "$REF"
  echo "acceptance: verifying clean checkout of $REF"
else
  echo "acceptance: verifying current working tree"
fi

command -v node >/dev/null 2>&1 || { echo "acceptance: FAIL node not found" >&2; exit 1; }
echo "acceptance: node $(node --version)"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

npm test

echo "acceptance: demo"
npm run demo --silent

echo "acceptance: edge spot-checks"
REQUEST_DIR="$(mktemp -d wayselect-acceptance-request-XXXXXX)"
trap 'rm -rf "$REQUEST_DIR" ${WORKDIR:+"$WORKDIR"}' EXIT INT TERM

make_request() {
  name="$1"; operation="$2"; capabilities="$3"; allow="$4"
  node -e "
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
  evaluationTime: '2026-09-26T16:00:00.000Z',
  maxEvidenceAgeHours: 72,
  selection: {
    operation: process.argv[2],
    requiredCapabilities: JSON.parse(process.argv[3]),
    providerAllowlist: process.argv[4].split(','),
  },
}, null, 2));
" "$REQUEST_DIR/$name.json" "$operation" "$capabilities" "$allow"
}

make_request tie-break chat '["toolUse"]' 'northstar,orbit'
make_request no-eligible chat '["vision"]' 'northstar,orbit'
make_request unsupported embeddings '[]' 'northstar,orbit'
make_request disallowed chat '["toolUse"]' 'legacy'

node bin/wayselect --request "$REQUEST_DIR/tie-break.json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.selection.status!=='selected'||r.selection.selected.routeId!=='northstar/alpha-chat'){console.error('tie-break: FAIL');process.exit(1)}console.log('tie-break: PASS selects northstar/alpha-chat')})"

node bin/wayselect --request "$REQUEST_DIR/no-eligible.json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.selection.status!=='no-eligible-route'){console.error('no-eligible-route: FAIL');process.exit(1)}console.log('no-eligible-route: PASS')})"

node bin/wayselect --request "$REQUEST_DIR/unsupported.json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.selection.status!=='no-eligible-route'){console.error('unsupported-operation: FAIL');process.exit(1)}console.log('unsupported-operation: PASS')})"

node bin/wayselect --request "$REQUEST_DIR/disallowed.json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.selection.status!=='no-eligible-route'){console.error('disallowed-provider: FAIL');process.exit(1)}console.log('disallowed-provider: PASS')})"

echo "acceptance: PASS"
