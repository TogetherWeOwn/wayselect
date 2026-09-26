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
# pre-check). No network access is expected: install is a no-op (stdlib
# only, no dependencies) and every test runs under the no-network guard.
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
  npm ci --offline
else
  echo "acceptance: no lockfile (stdlib only), skipping install"
fi

npm test

echo "acceptance: demo"
npm run demo --silent

echo "acceptance: edge spot-checks"
node bin/wayselect select \
  --operation chat --require toolUse --allow northstar,orbit \
  --evaluation-time 2026-09-24T12:00:00.000Z --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.status!=='selected'||r.selectedRouteId!=='northstar/alpha-chat'){console.error('tie-break: FAIL');process.exit(1)}console.log('tie-break: PASS selects northstar/alpha-chat')})"

node bin/wayselect select \
  --operation chat --require vision --allow northstar,orbit \
  --evaluation-time 2026-09-24T12:00:00.000Z --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.status!=='no-eligible-route'){console.error('no-eligible-route: FAIL');process.exit(1)}console.log('no-eligible-route: PASS')})"

node bin/wayselect select \
  --operation embeddings --allow northstar,orbit \
  --evaluation-time 2026-09-24T12:00:00.000Z --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.status!=='no-eligible-route'){console.error('unsupported-operation: FAIL');process.exit(1)}console.log('unsupported-operation: PASS')})"

node bin/wayselect select \
  --operation chat --require toolUse --allow legacy \
  --evaluation-time 2026-09-24T12:00:00.000Z --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);if(r.status!=='no-eligible-route'){console.error('disallowed-provider: FAIL');process.exit(1)}console.log('disallowed-provider: PASS')})"

echo "acceptance: PASS"
