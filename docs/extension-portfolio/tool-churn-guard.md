# tool-churn-guard

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Detect repeated low-value tool polling and retries
- **Unique trigger:** Repeated status, policy, roadmap, Git, or identical failed calls
- **Canonical surface:** metadata-only lifecycle hook
- **Overlap decision:** Tool descriptions prevent first-order mistakes; guard intervenes only after repetition
- **Mutation class:** advisory hook
- **Privacy class:** tool/operation/count/reason only; no arguments or result bodies
- **Success metric:** Repeated calls receive one actionable suggestion without blocking work
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_TOOL_CHURN_GUARD
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
