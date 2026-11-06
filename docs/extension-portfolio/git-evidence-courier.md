# git-evidence-courier

- **Schema:** 4
- **Owner:** Git workflow maintainer
- **User problem:** Read-only Git proof and explicit publish command
- **Unique trigger:** Git readiness or user-confirmed publish
- **Canonical surface:** gitevidence/gitverify
- **Overlap decision:** commit_plan owns local commits
- **Mutation class:** read-only plus explicit command publish
- **Privacy class:** Git metadata only
- **Success metric:** Local/remote SHA and tree state reconcile
- **Dependency readiness:** Git repository
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** retain-current-settings
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `gitevidence`: **keep**; canonical=gitevidence/gitverify; trigger=Git readiness or user-confirmed publish; evidence=unique trigger documented and regression coverage retained
- `gitverify`: **keep**; canonical=gitevidence/gitverify; trigger=Git readiness or user-confirmed publish; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
