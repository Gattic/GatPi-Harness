# learning-loop-coordinator

- **Schema:** 4
- **Owner:** learning maintainer
- **User problem:** Reviewed aggregate outcome mining and proposals
- **Unique trigger:** Explicit learning review or configured ingest
- **Canonical surface:** learning_loop
- **Overlap decision:** session miner supplies aggregate evidence
- **Mutation class:** preview/review/apply record
- **Privacy class:** aggregate metadata only
- **Success metric:** Proposals pass review and verification before apply records
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_LEARNING_LOOP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `learning_loop`: **keep**; canonical=learning_loop; trigger=Explicit learning review or configured ingest; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
