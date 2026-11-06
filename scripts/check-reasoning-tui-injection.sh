#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v tmux >/dev/null 2>&1; then
  echo "skip - tmux unavailable for reasoning TUI injection smoke"
  exit 0
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "skip - pi unavailable for reasoning TUI injection smoke"
  exit 0
fi

run_pi_command() {
  local cmd="$1"
  local session="pi-reasoning-injection-smoke-$$-$RANDOM"
  local trace_dir="/tmp/${session}-trace"
  rm -rf "$trace_dir"
  mkdir -p "$trace_dir"
  tmux new-session -d -s "$session" "cd '$PWD' && PI_COGNITIVE_AUTO_VERIFY=0 PI_COGNITIVE_ORCHESTRATION_ENABLED=0 PI_COGNITIVE_AUTO_BRANCH=0 PI_TRACE_DIR='$trace_dir' pi --no-session --no-extensions -e '$PWD/.pi/extensions/reasoning-runtime/index.ts'"
  sleep 8
  tmux send-keys -t "$session" -l "$cmd"
  tmux send-keys -t "$session" Enter
  sleep 8
  tmux capture-pane -epJt "$session" -S -400
  tmux kill-session -t "$session" >/dev/null 2>&1 || true
  rm -rf "$trace_dir"
}

version_out="$(run_pi_command /reasoning-version)"
selftest_out="$(run_pi_command /reasoning-self-test)"
combined="$version_out
$selftest_out"

grep -q '"reasoningAdapterAvailable": true' <<<"$combined"
grep -q '"ok": true' <<<"$combined"
grep -q '"architectureSemanticMemoryDeduped": true' <<<"$combined"
grep -q '"renderHasVersionBanner": true' <<<"$combined"
grep -q '"renderDoesNotExposeScratchpad": true' <<<"$combined"

echo "reasoning TUI injection smoke passed"
