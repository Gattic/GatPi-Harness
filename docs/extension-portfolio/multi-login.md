# multi-login

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Multiple logins per provider with prioritized account failover and per-directory model selection
- **Unique trigger:** Model selection, session start, account usage-limit or auth failure, or /multi-login
- **Canonical surface:** model_select/session_start persistence and message_end failover with pi.setModel
- **Overlap decision:** Sole multi-login provider; Pi auth stores each alias login
- **Mutation class:** provider registration, cooldown state and directory model preferences
- **Privacy class:** provider/model ids, directory hashes and cooldown timestamps only; credentials stay in Pi auth storage
- **Success metric:** Usage-limited turns continue on the next signed-in account without re-prompting
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** retain-current-settings
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
