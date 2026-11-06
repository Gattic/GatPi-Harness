#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -x node_modules/.bin/tsc ]]; then
  exec node_modules/.bin/tsc --noEmit
fi
if command -v tsc >/dev/null 2>&1; then
  exec tsc --noEmit
fi

printf 'TypeScript compiler is not installed. Run: npm install --offline\n' >&2
exit 1
