#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

global_trace_root="${PI_GLOBAL_TRACE_DIR:-$HOME/.pi/agent/traces}"

usage() {
  cat <<'USAGE'
Usage: scripts/clean-runtime-state.sh [--yes] [--include-global]

Removes project-local runtime state by default:
  .pi/cognitive-automation
  .pi/session-branches
  .pi/verification-evidence
  .pi/verification-metrics.json
  .pi/trace
  .pi/traces
  .pi/cognitive-automation/reasoning-export-*.json
  .pi/hermes-advisory
  .pi/hermes-skill-candidates
  .pi/obsidian

With --include-global, also removes the explicit global trace root:
  ~/.pi/agent/traces/*

USAGE
}

yes=0
include_global=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) yes=1 ;;
    --include-global) include_global=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

targets=(
  ".pi/cognitive-automation"
  ".pi/cognitive-automation/reasoning-export-*.json"
  ".pi/session-branches"
  ".pi/verification-evidence"
  ".pi/verification-metrics.json"
  ".pi/trace"
  ".pi/traces"
  ".pi/hermes-advisory"
  ".pi/hermes-skill-candidates"
  ".pi/obsidian"
)

if [[ "$include_global" == 1 ]]; then
  targets+=("$global_trace_root")
fi

printf 'Runtime state cleanup targets:\n'
printf '  %s\n' "${targets[@]}"

if [[ "$yes" != 1 ]]; then
  printf 'Proceed? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo 'aborted'; exit 0 ;; esac
fi

for target in "${targets[@]}"; do
  if [[ -e "$target" ]]; then
    rm -rf -- "$target"
    printf 'removed %s\n' "$target"
  fi
done

printf 'runtime state cleanup complete\n'
