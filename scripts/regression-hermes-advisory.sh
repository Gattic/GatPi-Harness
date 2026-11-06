#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/check-hermes-static.sh
node tests/hermes-advisory.test.js
node tests/hermes-integration-scorecard.test.js
node tests/goal-store-runner.test.js
node tests/obsidian-adapter.test.js
node tests/prompt-suggestions.test.js
node tests/skill-synthesis.test.js

printf 'Hermes advisory regression checks passed\n'
