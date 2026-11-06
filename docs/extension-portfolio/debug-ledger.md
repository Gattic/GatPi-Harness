# debug-ledger

- **Schema:** 4
- **Owner:** debug tooling maintainer
- **User problem:** Durable hypothesis/change/observation bug threads
- **Unique trigger:** Bug investigation
- **Canonical surface:** debug_ledger
- **Overlap decision:** fix_recall retrieves prior resolved threads
- **Mutation class:** local state
- **Privacy class:** bounded public evidence only
- **Success metric:** Every attempt receives a verdict and confirmed resolution
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_DEBUG_LEDGER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `debug_ledger`: **keep**; canonical=debug_ledger; trigger=Bug investigation; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
