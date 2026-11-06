#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/.pi/extensions/reasoning-runtime/index.ts"
log="${TMPDIR:-/tmp}/pi-topology-tui-$$.log"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-topology-state-XXXXXX")"
trap 'rm -rf "$state_root"' EXIT

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for topology TUI validation; install util-linux/bsdutils to run it\n'
  exit 0
fi

# A successful planner applies a roadmap before the coder can run. Isolate the
# project too, not just cognitive/subagent storage, so this cannot alter the
# caller's roadmap, exports, Git worktrees, or execution-outcome evidence.
project="$state_root/project"
mkdir -p "$project/.pi/topologies"
cp "$root/.pi/topologies/planner-coder-verifier.json" "$root/.pi/topologies/subagent-smoke.json" "$project/.pi/topologies/"
printf 'Deterministic topology TUI fixture.\n' > "$project/README.md"
printf '.pi/\n' > "$project/.gitignore"
git -C "$project" init -q
git -C "$project" add README.md .gitignore
git -C "$project" -c user.name='Topology TUI fixture' -c user.email='fixture@invalid' -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm 'Initialize disposable TUI fixture'
cd "$project"

tui_timeout=180
set +e
(
  # Cold startup can outlast a fixed sleep. --verbose guarantees this banner.
  deadline=$((SECONDS + tui_timeout))
  until [[ -s "$log" ]] && grep -q '\[Extensions\]' "$log"; do
    if (( SECONDS >= deadline )); then
      printf 'topology TUI validation timed out waiting for startup; log: %s\n' "$log" >&2
      exit 1
    fi
    sleep 0.1
  done
  printf '/topology-reload\r'
  sleep 3
  printf '/topology-list\r'
  sleep 3
  printf '/topology-roles\r'
  sleep 3
  printf '/topology-run project-planner-coder-verifier deterministic topology TUI smoke\r'
  sleep "${PI_TOPOLOGY_TUI_RUN_WAIT_SECONDS:-8}"
  printf '/topology-runs project-planner-coder-verifier\r'
  sleep 3
  printf '/topology-show-run latest\r'
  sleep 3
  printf '/topology-export latest\r'
  sleep 3
  printf '/topology-metrics project-planner-coder-verifier\r'
  sleep 3
  printf '/topology-run project-subagent-smoke deterministic subagent topology smoke\r'
  sleep "${PI_TOPOLOGY_TUI_SUBAGENT_RUN_WAIT_SECONDS:-20}"
  printf '/subagent-list\r'
  sleep 3
  printf '/topology-doctor\r'
  sleep 3
  printf '/topology-trace project-subagent-smoke\r'
  sleep 3
  printf '/topology-replay project-subagent-smoke\r'
  sleep 3
  printf '\003'
  sleep 1
  printf '\003'
) | timeout "$tui_timeout" script -q -f -e -c "PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1 PI_TOPOLOGY_AUTO_ROUTE=off PI_ROLE_WORKER_SHADOW_CANARY=0 PI_COGNITIVE_STORAGE_ROOT='$state_root/cognitive' PI_SUBAGENT_STATE_ROOT='$state_root/subagents' PI_TOPOLOGY_CONFIG_DIRS=.pi/topologies PI_COGNITIVE_AUTO_VERIFY=0 PI_ROLE_MUTATION=isolated PI_SUBAGENT_EXECUTION_FIXTURE_RESULT='fixture topology subagent success' pi --no-session --no-extensions --verbose -e '$ext'" "$log" >/dev/null
pipeline_status=("${PIPESTATUS[@]}")
set -e

node "$root/scripts/check-topology-tui-results.js" "$state_root/cognitive/topologies/runs" "${log%.log}.runs.json"
if (( pipeline_status[0] != 0 || pipeline_status[1] != 0 )); then
  printf 'topology TUI validation process failed (%s); log: %s\n' "${pipeline_status[*]}" "$log" >&2
  exit 1
fi
if [[ ! -s "$log" ]]; then
  printf 'topology TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Loaded .* topology config files' "$log"; then
  printf 'topology TUI validation did not observe config reload; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'project-planner-coder-verifier' "$log"; then
  printf 'topology TUI validation did not observe project topology; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'project-subagent-smoke' "$log" || ! grep -q 'worker role=researcher status=succeeded' "$log"; then
  printf 'topology TUI validation did not observe compact subagent-backed node status; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Exported topology run' "$log"; then
  printf 'topology TUI validation did not observe export output; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'totalRuns' "$log"; then
  printf 'topology TUI validation did not observe metrics output; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Topology diagnostics' "$log"; then
  printf 'topology TUI validation did not observe doctor output; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'topology.topology.completed' "$log"; then
  printf 'topology TUI validation did not observe trace/replay completion event; log: %s\n' "$log" >&2
  exit 1
fi
if [[ ! -d "$state_root/cognitive/topologies/runs" ]]; then
  printf 'topology TUI validation did not persist topology runs; log: %s\n' "$log" >&2
  exit 1
fi
printf 'topology TUI validation passed; log: %s\n' "$log"
