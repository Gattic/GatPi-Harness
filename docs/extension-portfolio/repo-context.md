# repo-context

- **Schema:** 4
- **Owner:** Git workflow maintainer
- **User problem:** One-call current repository orientation
- **Unique trigger:** Session start or repository switch
- **Canonical surface:** repo_context
- **Overlap decision:** gitevidence is canonical for publish/readiness proof
- **Mutation class:** read-only
- **Privacy class:** Git metadata and instruction digest
- **Success metric:** Avoids repeated shell status/log/layout rituals
- **Dependency readiness:** Git optional
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_REPO_CONTEXT
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `repo_context`: **keep**; canonical=repo_context; trigger=Session start or repository switch; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
