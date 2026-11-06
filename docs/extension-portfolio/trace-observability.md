# trace-observability

- **Schema:** 4
- **Owner:** observability maintainer
- **User problem:** Runtime trace inspection and replay
- **Unique trigger:** Explicit trace command or runtime instrumentation
- **Canonical surface:** trace commands
- **Overlap decision:** runtime_doctor summarizes health
- **Mutation class:** command/runtime hook
- **Privacy class:** payload capture off/redacted by policy
- **Success metric:** Trace explains failures without sensitive payloads
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_TRACE_ENABLED
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- No model tools; command/UI/runtime-hook lifecycle is measured separately.

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
