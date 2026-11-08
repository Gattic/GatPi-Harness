# project-scope

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Reach another in-scope project directory's .pi state, bounded logs, and state files
- **Unique trigger:** Explicit second-directory access request
- **Canonical surface:** project_scope
- **Overlap decision:** memory_explorer/memory_curator read a named project's memories; analysis tools operate inside scope roots
- **Mutation class:** read-only
- **Privacy class:** local .pi metadata, bounded log tails, and one bounded state file; confined to <root>/.pi
- **Success metric:** Another in-scope root's .pi state and logs are reachable without widening path confinement
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_PROJECT_SCOPE
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `project_scope`: **keep**; canonical=project_scope; trigger=Explicit second-directory access request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
