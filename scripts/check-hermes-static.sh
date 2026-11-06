#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v rg >/dev/null 2>&1; then
  printf 'rg is required for Hermes static checks\n' >&2
  exit 1
fi

[[ -f extensions/hermes-advisory/index.ts ]]
[[ ! -e extensions/hermes-memory ]]

if rg -n 'hermes-client\.js|runHermesQuiet|runHermes\(' extensions .pi/extensions src/obsidian-adapter.js --glob '*.ts' --glob '*.js' | grep -v '^src/hermes-advisory.js:'; then
  printf 'direct Hermes subprocess consumer found outside advisory adapter\n' >&2
  exit 1
fi
if rg -n -- '--continue|sessions rename' src/hermes-advisory.js extensions/hermes-advisory .pi/extensions/goal extensions/prompt-suggestions src/obsidian-adapter.js; then
  printf 'durable Hermes conversation path found in active integration\n' >&2
  exit 1
fi
printf 'Hermes advisory static checks passed\n'
