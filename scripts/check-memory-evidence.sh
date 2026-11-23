#!/usr/bin/env bash
# Strict memory-evidence gate for the passive rollout. Exits non-zero when any
# criterion (S1/R/SD/C/A) is short on count or distinct days, and prints the
# failing keys to stderr. Read-only: it forwards --json and an optional cwd.
set -uo pipefail
cd "$(dirname "$0")/.."
exec node scripts/memory-evidence-window.js --strict "$@"
