#!/usr/bin/env bash
set -euo pipefail
ROOT=${PI_TRACE_DIR:-$HOME/.pi/agent/traces-benchmark}
EXT=${PI_TRACE_EXTENSION:-.pi/extensions/trace-observability/index.ts}
mkdir -p "$ROOT"

printf 'Trace observability benchmark\n'
printf 'extension: %s\ntrace dir: %s\n' "$EXT" "$ROOT"

node <<'NODE'
const { appendFileSync, rmSync, mkdirSync } = require('fs');
const { join } = require('path');
const { performance } = require('perf_hooks');
const root = process.env.PI_TRACE_DIR || `${process.env.HOME}/.pi/agent/traces-benchmark`;
mkdirSync(root, { recursive: true });
const file = join(root, 'append-throughput.jsonl');
try { rmSync(file); } catch {}
const n = 10000;
const payload = { event_id:'x', timestamp:new Date().toISOString(), correlation_id:'c', session_id:'s', subsystem:'bench', severity:'info', category:'performance', name:'bench', payload:{ok:true,n:1} };
const line = JSON.stringify(payload)+'\n';
const t0 = performance.now();
for (let i=0;i<n;i++) appendFileSync(file, line);
const dt = performance.now()-t0;
console.log(JSON.stringify({events:n,total_ms:dt,per_event_ms:dt/n,events_per_sec:n/(dt/1000)}, null, 2));
NODE

cat <<EOF

Manual enabled/disabled startup checks:
  time PI_TRACE_ENABLED=0 pi -p --no-extensions -e "$EXT" 'echo ok'
  time PI_TRACE_DIR="$ROOT" pi -p --no-extensions -e "$EXT" 'echo ok'
EOF
