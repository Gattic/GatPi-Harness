#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Standalone model-free lifecycle smoke for the cognitive extension with skill
# synthesis enabled. check-extensions-smoke.sh already performs this probe in
# the full suite, but keeping it here makes this focused script self-contained.
PI_SKILL_AUTO_CAPTURE=0 \
node scripts/extension-smoke-runner.js rpc .pi/extensions/reasoning-runtime/index.ts

node tests/skill-extension-source.test.js >/dev/null
printf 'skill synthesis TUI smoke passed\n'
