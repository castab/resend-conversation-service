#!/bin/sh
set -eu

if [ "$#" -ge 2 ] && [ "$1" = "node" ] && [ "$2" = "dist/server.js" ]; then
  node scripts/validate-runtime-env.mjs
fi

exec "$@"
