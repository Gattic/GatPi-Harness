# automation-loop

- **Schema:** 4
- **Owner:** workflow tooling maintainer
- **User problem:** Bounded repeated same-prompt autonomous work
- **Unique trigger:** Explicit current-user loop/autonomy request
- **Canonical surface:** automation_loop
- **Overlap decision:** run_monitor observes one process without repeating model work
- **Mutation class:** bounded orchestration
- **Privacy class:** private metadata-only lifecycle telemetry
- **Success metric:** Eligible loops terminate with evidence/promise and no safety bypass
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_AUTOMATION_LOOP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `automation_loop`: **keep**; canonical=automation_loop; trigger=Explicit current-user loop/autonomy request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
