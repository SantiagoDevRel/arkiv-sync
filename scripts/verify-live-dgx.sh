#!/usr/bin/env bash
set -euo pipefail
# Argument: the unchanged shared tools/secrets.mjs runner, supplied by the operator.
# This reads named secrets through the approved runner, never shell-sources a secret file.
export AGENT_SECRETS_DIR="${AGENT_SECRETS_DIR:-$HOME/.agent-secrets}"
node "$1" run --vars arkiv-rabdi.env --vars arkiv-rabdi-test-wallets.env -- \
  docker run --rm --pull never --user "$(id -u):$(id -g)" --network host \
  -v "$PWD:/work" -v "$TMPDIR:$TMPDIR" -e TMPDIR -e HOME=/tmp \
  -e TEST_SYNC_PRIVATE_KEY -e TEST_SYNC_ADDRESS -e ARKIV_ACCESS_KEY_A -w /work \
  node:22-alpine sh scripts/verify-node22-live.sh
