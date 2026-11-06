#!/usr/bin/env bash
# Isolated request-queue gate: needs Docker and the pinned Redis image cached locally.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$root/scripts/setup-pi-queue.sh" --check
exec node --test --test-concurrency=1 "$root/src/pi-queue/test/request-queue.test.js"
