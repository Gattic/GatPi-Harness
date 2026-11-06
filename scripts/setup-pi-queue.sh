#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$root/src/pi-queue"
if [[ "${1:-}" == "--check" && $# == 1 ]]; then
  test -f "$runtime/node_modules/ioredis/package.json"
  node "$runtime/cli.js" --help >/dev/null
  exit
fi
if (( $# )); then printf 'Usage: scripts/setup-pi-queue.sh [--check]\n' >&2; exit 2; fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<19)) throw new Error("Pi request queue requires Node >=22.19")'
npm --prefix "$runtime" ci --ignore-scripts --no-audit --no-fund
printf 'Pi request queue client installed. No Redis connection, credentials or containers were created.\n'
