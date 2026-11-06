# run-deck

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Durable tracking for training/download/generation runs
- **Unique trigger:** Long recurring-metric process
- **Canonical surface:** run_deck
- **Overlap decision:** bg_run is canonical for one-off build/test/server commands
- **Mutation class:** process control/local registry
- **Privacy class:** bounded logs and parsed metrics
- **Success metric:** Run reaches recorded terminal verdict
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_RUN_DECK
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `run_deck`: **keep**; canonical=run_deck; trigger=Long recurring-metric process; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
