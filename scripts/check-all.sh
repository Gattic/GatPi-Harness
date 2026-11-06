#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

# Deterministic verification only: no provider, network, TUI, or extension-load
# probes. Live checks live in scripts/check-live.sh so a provider quota/rate
# limit cannot be reported as a code regression, and a code regression cannot
# hide behind provider unavailability.
run_test() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${PI_TEST_FILE_TIMEOUT:-600}" node "$1"
  else
    node "$1"
  fi
}

failures=0
total=0
for test in tests/*.test.js; do
  [ -e "$test" ] || continue
  total=$((total + 1))
  printf '== %s\n' "$test"
  if ! run_test "$test"; then
    printf 'FAIL %s\n' "$test"
    failures=$((failures + 1))
  fi
done

printf '== scripts/check-hermes-static.sh\n'
scripts/check-hermes-static.sh || failures=$((failures + 1))

if [[ "${PI_CHECK_QUEUE:-0}" == "1" ]]; then
  printf '== scripts/check-pi-queue.sh\n'
  scripts/check-pi-queue.sh || failures=$((failures + 1))
fi

if [[ "$failures" -ne 0 ]]; then
  printf 'deterministic checks failed (%s failure(s), %s test file(s))\n' "$failures" "$total" >&2
  exit 1
fi

printf 'all deterministic checks passed (%s test files)\n' "$total"
