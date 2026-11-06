# Trace workflow example

Launch Pi with the project-local extension:

```bash
PI_TRACE_DIR=/tmp/pi-traces pi -e .pi/extensions/trace-observability/index.ts
```

Inside Pi:

```text
/trace-status
/trace-live model_request
/trace-timeline
/trace-export
/trace-replay summary
/trace-replay step 0
```

Inspect exported JSON:

```bash
jq '.events[] | {time:.timestamp, cat:.category, name:.name, corr:.correlation_id}' /tmp/pi-traces/*.export.json
```

Filter one agent cycle by correlation id:

```text
/trace-export abcd1234
```
