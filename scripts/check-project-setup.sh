#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

failures=0
ok() { printf 'ok - %s\n' "$1"; }
not_ok() { printf 'not ok - %s\n' "$1" >&2; failures=$((failures + 1)); }
check() {
  local name=$1
  shift
  if "$@"; then ok "$name"; else not_ok "$name"; fi
}

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
trace_dir="${PI_TRACE_DIR:-$(pwd)/.pi/traces}"
git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
harness_root="$(pwd)"
if [[ -n "$git_common_dir" ]]; then harness_root="$(dirname "$git_common_dir")"; fi
check "pi CLI is available" command -v pi
check "hermes CLI is available" command -v hermes
check "timeout utility is available" command -v timeout
check "version-controlled Hermes advisory extension exists" test -f extensions/hermes-advisory/index.ts
check "project trace extension exists" test -f .pi/extensions/trace-observability/index.ts
check "project cognitive extension exists" test -f .pi/extensions/reasoning-runtime/index.ts
check "project goal extension exists" test -f .pi/extensions/goal/index.ts
check "global Pi settings file exists" test -f "$agent_dir/settings.json"
check "global settings loads harness .pi/extensions" node -e 'const fs=require("fs"),path=require("path"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const target=path.resolve(process.argv[2]); process.exit((s.extensions||[]).map((p)=>path.resolve(p)).includes(target)?0:1)' "$agent_dir/settings.json" "$harness_root/.pi/extensions"
check "global settings loads harness repo extensions" node -e 'const fs=require("fs"),path=require("path"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const target=path.resolve(process.argv[2]); process.exit((s.extensions||[]).map((p)=>path.resolve(p)).includes(target)?0:1)' "$agent_dir/settings.json" "$harness_root/extensions"
check "multi-login extension exists" test -f extensions/multi-login/index.ts
check "queue extension exists" test -f extensions/pi-queue/index.ts
check "queue client runtime is installed" scripts/setup-pi-queue.sh --check
check "queue client local readiness" node -e 'const r=require("./src/pi-queue-adapter").queueReadiness(); console.log(JSON.stringify(r)); process.exit(["invalid-config","not-installed"].includes(r.outcome)?1:0)'
check "trace directory is writable" mkdir -p "$trace_dir"

smoke_agent_dir="$(mktemp -d)"
smoke_trace_dir="${TMPDIR:-/tmp}/pi-trace-setup-$$"
trap 'rm -rf "$smoke_agent_dir" "$smoke_trace_dir"' EXIT

smoke_timeout_seconds="${PI_PROJECT_SETUP_SMOKE_TIMEOUT_SECONDS:-90}"
if [[ ! "$smoke_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then smoke_timeout_seconds=90; fi

smoke_command() {
  local name="$1"
  shift
  local log started elapsed status
  log="$(mktemp "${TMPDIR:-/tmp}/pi-project-setup-smoke.XXXXXX")"
  started=$SECONDS
  if PI_OFFLINE=1 PI_CODING_AGENT_DIR="$smoke_agent_dir" timeout --signal=TERM --kill-after=5s "${smoke_timeout_seconds}s" "$@" </dev/null >"$log" 2>&1; then
    elapsed=$((SECONDS - started))
    rm -f "$log"
    ok "$name (${elapsed}s)"
    return
  else
    status=$?
  fi
  elapsed=$((SECONDS - started))
  if (( status == 124 || status == 137 )); then
    not_ok "$name (timed out after ${elapsed}s; limit=${smoke_timeout_seconds}s)"
  else
    not_ok "$name (exit=$status after ${elapsed}s)"
  fi
  if [[ -s "$log" ]]; then
    printf '%s\n' "--- ${name} output (last 40 lines) ---" >&2
    tail -n 40 "$log" >&2
  fi
  rm -f "$log"
}

PI_COGNITIVE_AUTO_VERIFY=0 \
PI_COGNITIVE_AUTO_CHECKPOINT=0 \
PI_COGNITIVE_ORCHESTRATION_ENABLED=0 \
smoke_command "cognitive extension command smoke" \
  pi -p --no-session --no-extensions -e .pi/extensions/reasoning-runtime/index.ts '/cognitive-status'

PI_TRACE_DIR="$smoke_trace_dir" \
smoke_command "trace extension command smoke" \
  pi -p --no-session --no-extensions -e .pi/extensions/trace-observability/index.ts '/trace-status'

smoke_command "goal extension command smoke" \
  pi -p --no-session --no-extensions -e .pi/extensions/goal/index.ts '/goal-status'

smoke_command "Hermes advisory extension command smoke" \
  pi -p --no-session --no-extensions -e extensions/hermes-advisory/index.ts '/hermes-status'

smoke_command "multi-login extension command smoke" \
  pi -p --no-session --no-extensions -e extensions/multi-login/index.ts '/multi-login'

PI_QUEUE_ENV="$smoke_agent_dir/queue-unconfigured.env" PI_QUEUE=1 \
smoke_command "queue extension offline readiness smoke" \
  pi -p --no-session --no-extensions -e extensions/pi-queue/index.ts '/queue-status'

if (( failures > 0 )); then
  printf '\n%d setup check(s) failed.\n' "$failures" >&2
  exit 1
fi

printf '\nproject setup checks passed\n'
