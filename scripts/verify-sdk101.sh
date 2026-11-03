#!/bin/sh
set -eu
npm ci --ignore-scripts --no-audit --no-fund
(cd web-demo && npm ci --ignore-scripts --no-audit --no-fund)
npm run typecheck
npm test
npm run lint
npm run build
node --test scripts/isolated-checkout.test.mjs scripts/vocabulary-build-check.test.mjs
node scripts/sdk-runtime-check.mjs
node scripts/pack-candidate.mjs
node scripts/verify-registry.mjs
node scripts/sdk-peer-check.mjs
node scripts/sdk-guidance-mutation.mjs
node scripts/inspect-pack.mjs
(cd web-demo && npm run build)
node scripts/vocabulary-build-check.mjs
