# project-intelligence

- **Schema:** 4
- **Owner:** project tooling maintainer
- **User problem:** Repository topology, verifier, and safe-config profiling
- **Unique trigger:** Repository onboarding or test-impact planning
- **Canonical surface:** project_intelligence/project_profiler
- **Overlap decision:** code_context localizes source; build runner executes
- **Mutation class:** read-only plus explicit config write
- **Privacy class:** repository metadata
- **Success metric:** Profiles map real repository evidence to safe recommendations
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_PROJECT_INTELLIGENCE
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `project_intelligence`: **keep**; canonical=project_intelligence/project_profiler; trigger=Repository onboarding or test-impact planning; evidence=unique trigger documented and regression coverage retained
- `project_profiler`: **keep**; canonical=project_intelligence/project_profiler; trigger=Repository onboarding or test-impact planning; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
