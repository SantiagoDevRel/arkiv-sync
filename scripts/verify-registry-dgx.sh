#!/usr/bin/env bash
set -euo pipefail
docker run --rm --pull never --user "$(id -u):$(id -g)" --network host \
  -v "$PWD:/work" -v "$TMPDIR:$TMPDIR" -e TMPDIR -e HOME=/tmp -w /work \
  node:22-alpine sh scripts/verify-node22-registry.sh "$@"
