#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/.pi/extensions/reasoning-runtime/index.ts"
log="${TMPDIR:-/tmp}/pi-auto-role-delegate-tui-$$.log"
state_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-auto-role-delegate-state-XXXXXX")"
sentinel="$state_root/provider-sentinel.ts"
marker="$state_root/delegated-result.json"
trap 'rm -rf "$state_root"' EXIT
cd "$root"

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for automatic delegate TUI validation; install util-linux/bsdutils to run it\n'
  exit 0
fi

# The fixture topology settles before the parent turn. Capture the final provider
# payload to prove the typed delegated result was injected, then abort before any
# real parent provider request leaves the process.
cat >"$sentinel" <<'TS'
import { writeFileSync } from "node:fs";

function delegatedContent(value: any): string {
  if (typeof value === "string") return value.includes("<delegated_role_result>") ? value : "";
  if (Array.isArray(value)) return value.map(delegatedContent).find(Boolean) || "";
  if (value && typeof value === "object") return Object.values(value).map(delegatedContent).find(Boolean) || "";
  return "";
}

export default function captureDelegatedResult(pi: any) {
  pi.on("before_provider_request", (event: any, ctx: any) => {
    const delegated = delegatedContent(event?.payload || {});
    const packetText = delegated.match(/<delegated_role_result>\n(.+)\n<\/delegated_role_result>/)?.[1] || "";
    const marker = process.env.PI_AUTO_ROLE_DELEGATE_MARKER;
    if (marker) writeFileSync(marker, JSON.stringify({
      typedResultInjected: Boolean(packetText),
      bounded: packetText.length <= 12000,
      explicitPatchBoundary: packetText.includes('"parentPatchApplied":false') && packetText.includes('"patchApplication":"explicit"'),
      verifierPassed: packetText.includes('"role":"verifier"') && packetText.includes('"status":"passed"'),
    }));
    ctx.abort();
  });
}
TS

# Auth resolves before before_provider_request. A private agent directory and a
# non-persistent dummy key avoid user OAuth refreshes while retaining the real
# provider serializer. Offline mode suppresses background networking; ignoring
# project configuration keeps model overrides out of this fixture. Turn-intent
# classification is a separate provider call before the sentinel, so disable it.
mkdir -p "$state_root/agent"
(
  sleep 8
  printf 'Review src/role-router.js for correctness and regression risks, and report evidence.\r'
  sleep "${PI_AUTO_ROLE_DELEGATE_TUI_WAIT_SECONDS:-16}"
  printf '\003'
  sleep 1
  printf '\003'
) | timeout 70 script -q -f -c "PI_CODING_AGENT_DIR='$state_root/agent' PI_JEV_TURN_INTENT=off PI_AUTO_ROLE_DELEGATE_MARKER='$marker' PI_COGNITIVE_STORAGE_ROOT='$state_root/cognitive' PI_SUBAGENT_STATE_ROOT='$state_root/subagents' PI_COGNITIVE_AUTO_VERIFY=0 PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1 PI_ROLE_RUNTIME_VERSION=2 PI_ROLE_ROLLOUT_STAGE=R5 PI_ROLE_FIELD_PILOT=0 PI_ROLE_WORKER_SHADOW_CANARY=0 PI_ROLE_MUTATION=isolated PI_ROLE_SIDECAR=1 PI_TOPOLOGY_AUTO_ROUTE=delegate PI_SUBAGENT_EXECUTION_FIXTURE_RESULT='Fixture review completed with bounded repository evidence and passed verification.' pi --offline --no-approve --model anthropic/claude-sonnet-4-5 --api-key pi-auto-role-delegate-fixture --no-session --no-extensions -e '$ext' -e '$sentinel'" "$log" >/dev/null || true

if [[ ! -s "$log" ]]; then
  printf 'automatic delegate TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'topology=auto-reviewer-verifier-gate status=succeeded' "$log"; then
  printf 'automatic delegate TUI validation did not observe a successful automatic review topology: %s\n' "$log" >&2
  exit 1
fi
if [[ ! -s "$marker" ]]; then
  printf 'automatic delegate TUI validation did not reach the parent provider boundary: %s\n' "$log" >&2
  exit 1
fi
node - "$marker" "$state_root/subagents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const marker = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!marker.typedResultInjected || !marker.bounded || !marker.explicitPatchBoundary || !marker.verifierPassed) {
  console.error(`automatic delegate TUI validation observed an invalid parent payload: ${JSON.stringify(marker)}`);
  process.exit(1);
}
const root = process.argv[3];
const readJsonDir = (name) => {
  const dir = path.join(root, name);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) : [];
};
const records = readJsonDir("records");
const results = readJsonDir("results");
const roles = records.map((record) => record.role).sort();
if (records.length !== 2 || results.length !== 2 || roles.join(",") !== "reviewer,verifier" || results.some((result) => result.status !== "succeeded")) {
  console.error(`automatic delegate TUI validation expected successful reviewer/verifier children; roles=${roles.join(",")} results=${results.map((result) => result.status).join(",")}`);
  process.exit(1);
}
NODE

printf 'automatic delegate TUI validation passed; log: %s\n' "$log"
