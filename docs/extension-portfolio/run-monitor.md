# run-monitor

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Periodic observation of one managed long-running target
- **Unique trigger:** Explicit request to monitor/notify
- **Canonical surface:** run_monitor
- **Overlap decision:** run_deck/bg_run own execution; automation_loop must not babysit
- **Mutation class:** monitor control
- **Privacy class:** target IDs and bounded literal milestone only
- **Success metric:** Monitor notifies once on milestone/settlement/deadline
- **Dependency readiness:** bg_run or run_deck target
- **Lifecycle:** enabled-observation-pending
- **Default model exposure:** default
- **Rollback/control:** PI_RUN_MONITOR
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `run_monitor`: **keep-observation-pending**; canonical=run_monitor; trigger=explicit monitoring request for an existing managed target; evidence=excluded from early pruning until eligible long-run cohort exists

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
