# runtime-doctor

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Runtime health, stabilization, and performance diagnostics
- **Unique trigger:** Explicit health/latency/state request
- **Canonical surface:** runtime_doctor/session_stabilizer/performance_optimizer
- **Overlap decision:** project_profiler covers repository configuration
- **Mutation class:** preview-apply
- **Privacy class:** aggregate runtime metadata
- **Success metric:** Diagnostics identify risk and safe actions without deletion by default
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_RUNTIME_DOCTOR
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `performance_optimizer`: **keep**; canonical=runtime_doctor/session_stabilizer/performance_optimizer; trigger=Explicit health/latency/state request; evidence=unique trigger documented and regression coverage retained
- `runtime_doctor`: **keep**; canonical=runtime_doctor/session_stabilizer/performance_optimizer; trigger=Explicit health/latency/state request; evidence=unique trigger documented and regression coverage retained
- `session_stabilizer`: **keep**; canonical=runtime_doctor/session_stabilizer/performance_optimizer; trigger=Explicit health/latency/state request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
