# harness-awareness

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Concise discoverability for harness capabilities
- **Unique trigger:** Session prompt setup
- **Canonical surface:** harness awareness hook bound to the declared tool surface
- **Overlap decision:** Portfolio records own lifecycle detail
- **Mutation class:** prompt hook
- **Privacy class:** static guidance only
- **Success metric:** Guidance names only tools that are declared and points at activation for the rest
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_HARNESS_AWARE
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
