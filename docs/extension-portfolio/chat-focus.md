# chat-focus

- **Schema:** 4
- **Owner:** TUI maintainer
- **User problem:** Navigate and focus conversation branches
- **Unique trigger:** Explicit chat-focus command
- **Canonical surface:** chat-focus commands
- **Overlap decision:** Roadmap tracks work, not chat navigation
- **Mutation class:** command UI
- **Privacy class:** local session metadata
- **Success metric:** Command use completes without session loss
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
