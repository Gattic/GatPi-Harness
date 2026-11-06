#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/.pi/extensions/reasoning-runtime/index.ts"
log="${TMPDIR:-/tmp}/pi-subagent-tui-$$.log"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-subagent-state-XXXXXX")"
trap 'rm -rf "$state_root"' EXIT
cd "$root"

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for subagent TUI validation; install util-linux/bsdutils to run it\n'
  exit 0
fi

tui_timeout=180
(
  # Cold startup can outlast a fixed sleep. --verbose guarantees this banner.
  deadline=$((SECONDS + tui_timeout))
  until [[ -s "$log" ]] && grep -q '\[Extensions\]' "$log"; do
    if (( SECONDS >= deadline )); then
      printf 'subagent TUI validation timed out waiting for startup; log: %s\n' "$log" >&2
      exit 1
    fi
    sleep 0.1
  done
  printf '/subagent-preflight --role researcher --merge none deterministic subagent TUI smoke\r'
  sleep 3
  printf '/subagent --role researcher --merge none deterministic subagent TUI smoke\r'
  sleep "${PI_SUBAGENT_TUI_RUN_WAIT_SECONDS:-18}"
  printf '/subagent-list\r'
  sleep 3
  printf '/subagent-show latest\r'
  sleep 3
  printf '/subagent-merge latest summary_only\r'
  sleep 6
  printf '/branch-list\r'
  sleep 3
  printf '\003'
  sleep 1
  printf '\003'
) | timeout "$tui_timeout" script -q -f -c "PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1 PI_COGNITIVE_STORAGE_ROOT='$state_root/cognitive' PI_SUBAGENT_STATE_ROOT='$state_root/subagents' PI_COGNITIVE_AUTO_VERIFY=0 PI_SUBAGENT_EXECUTION_FIXTURE_RESULT='fixture subagent success: branch-backed deterministic output' pi --no-session --no-extensions --verbose -e '$ext'" "$log" >/dev/null || true

if [[ ! -s "$log" ]]; then
  printf 'subagent TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q '"launchDigest"' "$log" || ! grep -q '"processes": 0' "$log"; then
  printf 'subagent TUI validation did not observe side-effect-free preflight; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -Eq 'sub_.*status=created|Queued sub_|Running sub_|Started sub_|Subagent sub_.*succeeded' "$log"; then
  printf 'subagent TUI validation did not observe created/queued subagent; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -Eq '"status": "succeeded"|status=succeeded|[[:space:]]succeeded[[:space:]]' "$log"; then
  printf 'subagent TUI validation did not observe succeeded result; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'fixture subagent success' "$log"; then
  printf 'subagent TUI validation did not observe fixture result; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'subagent.summary' "$log"; then
  printf 'subagent TUI validation did not observe summary merge output; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'multi-agent' "$log"; then
  printf 'subagent TUI validation did not observe multi-agent branch; log: %s\n' "$log" >&2
  exit 1
fi
if [[ ! -d "$state_root/subagents/records" ]]; then
  printf 'subagent TUI validation did not persist isolated role state; log: %s\n' "$log" >&2
  exit 1
fi
printf 'subagent TUI validation passed; log: %s\n' "$log"
