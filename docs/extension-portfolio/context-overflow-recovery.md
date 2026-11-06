# context-overflow-recovery

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Recover useful public context after compaction/overflow
- **Unique trigger:** Compaction lifecycle or explicit rescue
- **Canonical surface:** context recovery commands
- **Overlap decision:** Reasoning runtime owns normal context injection
- **Mutation class:** command/runtime hook
- **Privacy class:** redacted bounded summaries
- **Success metric:** Recovery resumes without transcript leakage
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_COMPACTION_RECOVERY
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
