#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node tests/integration-boundary.test.js
node tests/integration-config-storage.test.js
node tests/storage-sink-conformance.test.js
node tests/extension-import-boundary.test.js
node tests/disabled-side-effects.test.js
node tests/adapter-lifecycle.test.js
node tests/cognitive-extension-persistence.test.js
node tests/cognitive-orchestration-config.test.js

printf 'integration boundary checks passed\n'
