# commit-plan

- **Schema:** 4
- **Owner:** Git workflow maintainer
- **User problem:** Exact-file logical local commits
- **Unique trigger:** Explicit user commit request
- **Canonical surface:** commit_plan
- **Overlap decision:** gitevidence/gitverify supply read-only proof
- **Mutation class:** mutating Git
- **Privacy class:** Git metadata only
- **Success metric:** Task-owned files commit in coherent groups
- **Dependency readiness:** Git repository
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_COMMIT_PLAN
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `commit_plan`: **keep**; canonical=commit_plan; trigger=Explicit user commit request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
