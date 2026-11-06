#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
warn() { printf 'warn - %s\n' "$1" >&2; }
fail() { printf 'not ok - %s\n' "$1" >&2; failures=$((failures + 1)); }
ok() { printf 'ok - %s\n' "$1"; }

if command -v pi >/dev/null 2>&1; then ok "pi CLI is available"; else fail "pi CLI is missing"; fi
if command -v hermes >/dev/null 2>&1; then ok "hermes CLI is available"; else warn "hermes CLI is missing; Hermes commands will fail until installed/configured"; fi
if command -v node >/dev/null 2>&1; then ok "node is available: $(node --version)"; else fail "node is missing"; fi

if [[ ! -f extensions/hermes-advisory/index.ts ]]; then fail "missing extensions/hermes-advisory/index.ts"; fi
if [[ ! -f .pi/extensions/reasoning-runtime/index.ts ]]; then fail "missing .pi/extensions/reasoning-runtime/index.ts"; fi
if [[ ! -f .pi/extensions/trace-observability/index.ts ]]; then fail "missing .pi/extensions/trace-observability/index.ts"; fi

if (( failures > 0 )); then
  printf '\nFix missing prerequisites/files, then rerun this script.\n' >&2
  exit 1
fi

scripts/pi-harness-refresh.sh --extensions --skills --no-check

printf '\nRunning project setup checks...\n'
scripts/check-project-setup.sh

printf '\nBootstrap complete. From this repo, run:\n'
printf '  pi\n'
printf '\nOptional full validation:\n'
printf '  scripts/pi-harness-refresh.sh --check-only\n'
