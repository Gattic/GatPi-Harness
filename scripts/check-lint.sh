#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -x node_modules/.bin/eslint ]]; then
  exec node_modules/.bin/eslint .pi/extensions extensions src/file-integration-storage.js src/state-retention.js src/shell-policy.js src/test-selection.js src/extension-import-policy.js src/extension-args.js src/extension-opportunity-reviews-store.js src/experiment-ledger.js src/debug-ledger.js --max-warnings 0
fi
if command -v eslint >/dev/null 2>&1; then
  exec eslint .pi/extensions extensions src/file-integration-storage.js src/state-retention.js src/shell-policy.js src/test-selection.js src/extension-import-policy.js src/extension-args.js src/extension-opportunity-reviews-store.js src/experiment-ledger.js src/debug-ledger.js --max-warnings 0
fi

printf 'ESLint is not installed. Run: npm install --offline\n' >&2
exit 1
