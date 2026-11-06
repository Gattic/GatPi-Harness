# goal

- **Schema:** 4
- **Owner:** workflow tooling maintainer
- **User problem:** User-controlled durable goal execution
- **Unique trigger:** Explicit goal commands
- **Canonical surface:** goal commands
- **Overlap decision:** automation_loop is canonical for bounded model-driven repetition
- **Mutation class:** command orchestration
- **Privacy class:** private local goal metadata
- **Success metric:** Goals stop/resume/archive without unsafe implicit mutation
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** retain-current-settings
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
