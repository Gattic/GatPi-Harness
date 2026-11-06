#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Per-extension coverage is model-free and deterministic: each explicitly
# loaded extension must survive a real Pi RPC session lifecycle and answer
# get_state/get_commands without emitting extension_error. The Node runner
# applies a per-probe deadline, logs START/PASS duration lines, and kills the
# detached process group on timeout so smoke probes cannot become orphans.
#
# One bounded full-fleet model turn remains below to cover provider streaming,
# print-mode settlement, and cross-extension agent lifecycle interactions.
node scripts/extension-smoke-runner.js all

for command in goal goal-status goal-stop goal-resume goal-log goal-doctor goal-clear goal-archive goal-plan goal-export goal-prune goal-trace goal-metrics; do
  grep -q "pi.registerCommand(\"$command\"" .pi/extensions/goal/index.ts
done

printf 'extension smoke checks passed\n'
