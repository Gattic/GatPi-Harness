# evidence-inbox

- **Schema:** 4
- **Owner:** verification maintainer
- **User problem:** Find recent external screenshots/logs/profiles
- **Unique trigger:** User says evidence was captured
- **Canonical surface:** evidence_inbox
- **Overlap decision:** evidence_binder binds proof packets
- **Mutation class:** read-only
- **Privacy class:** opaque artifact references; paths resolved only in memory
- **Success metric:** Relevant fresh artifact is located without broad copying
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_EVIDENCE_INBOX
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `evidence_inbox`: **keep**; canonical=evidence_inbox; trigger=User says evidence was captured; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
