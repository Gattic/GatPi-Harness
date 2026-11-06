# experiment-ledger

- **Schema:** 4
- **Owner:** experiment maintainer
- **User problem:** Pre-register and close measured experiment gates
- **Unique trigger:** Explicit experiment/A-B arc
- **Canonical surface:** experiment_ledger
- **Overlap decision:** run_deck executes long arms
- **Mutation class:** local state
- **Privacy class:** metrics and references; no raw payloads
- **Success metric:** Every gate and decision is recorded once
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_EXPERIMENT_LEDGER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `experiment_ledger`: **keep**; canonical=experiment_ledger; trigger=Explicit experiment/A-B arc; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
