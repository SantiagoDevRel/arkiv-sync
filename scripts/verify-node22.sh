#!/bin/sh
set -eu
node --version
npm run typecheck
npm test
npm run build
if [ "${1:-}" = '--discover' ]; then
  node scripts/discover-seed.mjs
else
  npm run lint
fi
