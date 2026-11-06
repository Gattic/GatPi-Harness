# bg-run

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Detached long build/test/server process ownership
- **Unique trigger:** One long one-off command
- **Canonical surface:** bg_run
- **Overlap decision:** run_deck is canonical for durable training/download metrics
- **Mutation class:** process control
- **Privacy class:** local logs; bounded output
- **Success metric:** Owned jobs have terminal exit evidence
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_BG_RUN
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `bg_run`: **keep**; canonical=bg_run; trigger=One long one-off command; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
