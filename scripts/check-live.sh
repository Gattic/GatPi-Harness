#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

# Provider-, TUI-, and extension-load-dependent checks. This script is opt-in
# (test_runner profile=live): every stage needs a configured provider and can
# fail for external reasons such as quota exhaustion or rate limiting. Failures
# here are not evidence of a code regression.
failures=0
run() {
  printf '== %s\n' "$*"
  "$@" || { printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); }
}

run scripts/check-extensions-smoke.sh
run scripts/check-prompt-suggestions-tui.sh
run scripts/check-reasoning-tui-injection.sh
run scripts/check-skill-synthesis-tui.sh

if [[ "${PI_CHECK_TUI:-0}" == "1" ]]; then
  for script in check-subagent-tui.sh check-topology-tui.sh check-worker-shadow-canary-tui.sh check-auto-role-delegate-tui.sh; do
    [[ -x "scripts/$script" ]] && run "scripts/$script"
  done
fi

[[ -x scripts/check-project-setup.sh ]] && run scripts/check-project-setup.sh
[[ -x scripts/check-pi-drift.sh ]] && run scripts/check-pi-drift.sh
[[ -x scripts/regression-hermes-advisory.sh ]] && run scripts/regression-hermes-advisory.sh

if [[ "$failures" -ne 0 ]]; then
  printf 'live checks failed: %s\n' "$failures" >&2
  exit 1
fi

printf 'all live checks passed\n'
