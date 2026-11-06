#!/usr/bin/env bash
set -euo pipefail

repo="${1:-$HOME/test-repo}"
root="$(cd "$(dirname "$0")/.." && pwd)"
ext="$root/.pi/extensions/goal/index.ts"
log="${TMPDIR:-/tmp}/pi-goal-tui-$$.log"
fixture="${TMPDIR:-/tmp}/pi-goal-fixture-$$.jsonl"

if ! command -v script >/dev/null 2>&1; then
  printf 'skip - script(1) unavailable for goal TUI validation; install util-linux/bsdutils to run it\n'
  exit 0
fi

mkdir -p "$repo"
cd "$repo"
if [[ ! -d .git ]]; then
  git init >/dev/null
  printf '# Test Repo\n' > README.md
  printf 'console.log("ok")\n' > index.js
  git add README.md index.js
  git -c user.email=test@example.invalid -c user.name='Test User' commit -m 'initial temp test repo' >/dev/null
fi

node - "$root" <<'NODE'
const path = require("node:path");
const root = process.argv[2];
const { EvidenceStore } = require(path.join(root, "src", "evidence-binder.js"));
new EvidenceStore({ cwd: process.cwd() }).saveEvidence({
  id: "evidence-goal-tui",
  createdAt: new Date(Date.now() + 60_000).toISOString(),
  ok: true,
  summary: "deterministic goal TUI fixture proof",
  commands: ["goal-tui-fixture"],
});
NODE

cat > "$fixture" <<'JSONL'
{"schemaVersion":3,"status":"running","action":{"kind":"inspect","targetKind":"status","targetRef":"fixture-repository","prompt":"Inspect fixture repository status without changing files."},"reasonCode":"collect-fixture-evidence","requiresUserInput":false,"completionEvidenceIds":[]}
{"schemaVersion":3,"status":"completed","action":null,"reasonCode":"fixture-verified","requiresUserInput":false,"completionEvidenceIds":["evidence-goal-tui"]}
JSONL

(
  sleep 4
  printf '/goal-clear --all\r'
  sleep 3
  printf '/goal-doctor\r'
  sleep 4
  printf '/goal deterministic fixture validation --max=2\r'
  sleep "${PI_GOAL_TUI_WAIT_SECONDS:-18}"
  printf '/goal-status\r'
  sleep 3
  printf '/goal-trace\r'
  sleep 3
  printf '/goal-log 2\r'
  sleep 3
  printf '/goal-export json .pi/goal-state/tui-export.json\r'
  sleep 3
  printf '/goal-archive completed\r'
  sleep 3
  printf '\003'
  sleep 1
  printf '\003'
) | timeout 180 script -q -f -c "PI_GOAL_CONTROLLER_FIXTURE='$fixture' PI_GOAL_EXECUTION_FIXTURE_RESULT='fixture evidence: README.md index.js listed by deterministic TUI harness' pi --no-session --no-extensions -e '$ext'" "$log" >/dev/null || true

rm -f "$fixture"

if [[ ! -s "$log" ]]; then
  printf 'goal TUI validation did not produce a session log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Goal goal_.* completed' "$log"; then
  printf 'goal TUI validation did not observe completion; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'Goal runner diagnostics' "$log"; then
  printf 'goal TUI validation did not observe /goal-doctor; log: %s\n' "$log" >&2
  exit 1
fi
if ! grep -q 'goal.prompt' "$log"; then
  printf 'goal TUI validation did not observe persisted/in-memory /goal-trace output; log: %s\n' "$log" >&2
  exit 1
fi
if [[ ! -f .pi/goal-state/tui-export.json ]]; then
  printf 'goal TUI validation did not create export file; log: %s\n' "$log" >&2
  exit 1
fi
printf 'goal TUI validation passed; log: %s\n' "$log"
