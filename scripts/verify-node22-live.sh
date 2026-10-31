#!/bin/sh
set -eu
sh scripts/verify-node22.sh
node scripts/pack-candidate.mjs --live
