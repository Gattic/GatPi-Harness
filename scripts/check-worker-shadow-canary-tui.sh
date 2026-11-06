#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/.pi/extensions/reasoning-runtime/index.ts"
log="${TMPDIR:-/tmp}/pi-worker-shadow-canary-tui-$$.log"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-worker-shadow-canary-state-XXXXXX")"
stopper="$state_root/stop-parent.ts"
trap 'rm -rf "$state_root"' EXIT
cd "$root"

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for worker shadow canary TUI validation; install util-linux/bsdutils to run it\n'
  exit 0
fi

# Let the reasoning-runtime input hook classify and start the worker, then consume
# the same prompt in a later test-only hook so this deterministic smoke never
# sends the independent parent turn to a provider. Explicitly enable topologies
# in the test process so an enclosing agent's opt-out cannot disable this fixture.
cat >"$stopper" <<'TS'
export default function stopParentTurn(pi: any) {
  pi.on("input", async (event: any) => String(event?.text || "").includes("PI_ROLE_MUTATION") ? { action: "handled" } : { action: "continue" });
}
TS

(
  sleep 8
  printf 'Read only config/harness-defaults.env and report the exact PI_ROLE_MUTATION value; do not edit files.\r'
  sleep "${PI_WORKER_SHADOW_TUI_WAIT_SECONDS:-14}"
  printf '\003'
  sleep 1
  printf '\003'
) | timeout 60 script -q -f -c "PI_COGNITIVE_STORAGE_ROOT='$state_root/cognitive' PI_SUBAGENT_STATE_ROOT='$state_root/subagents' PI_COGNITIVE_AUTO_VERIFY=0 PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1 PI_ROLE_RUNTIME_VERSION=2 PI_ROLE_ROLLOUT_STAGE=R0 PI_ROLE_FIELD_PILOT=1 PI_ROLE_WORKER_SHADOW_CANARY=1 PI_ROLE_MUTATION=off PI_ROLE_SIDECAR=1 PI_TOPOLOGY_AUTO_ROUTE=suggest PI_ROLE_MODEL_WORKER=local/DeepSeek-V4.1-Flash-1017 PI_ROLE_THINKING_WORKER=low PI_SUBAGENT_EXECUTION_FIXTURE_RESULT='fixture worker shadow success' pi --no-session --no-extensions -e '$ext' -e '$stopper'" "$log" >/dev/null || true

if [[ ! -s "$log" ]]; then
  printf 'worker shadow canary TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Worker shadow result (separate from parent answer).*succeeded' "$log"; then
  printf 'worker shadow canary TUI validation did not observe a separate successful worker result: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'topology=auto-worker-shadow-canary status=succeeded' "$log"; then
  printf 'worker shadow canary TUI validation did not execute the guarded runtime-only topology: %s\n' "$log" >&2
  exit 1
fi
if grep -q 'Working\.\.\.' "$log"; then
  printf 'worker shadow canary TUI validation unexpectedly started the independent parent provider turn: %s\n' "$log" >&2
  exit 1
fi
node - "$state_root/subagents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const readJsonDir = (name) => {
  const dir = path.join(root, name);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : [];
};
const records = readJsonDir("records");
const results = readJsonDir("results");
if (records.length !== 1 || results.length !== 1 || records[0].role !== "worker" || results[0].status !== "succeeded") {
  console.error(`worker shadow canary TUI validation expected one isolated successful worker; records=${records.length} results=${results.length}`);
  process.exit(1);
}
NODE

printf 'worker shadow canary TUI validation passed; log: %s\n' "$log"
