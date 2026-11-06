# completion-enforcement

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Continue authorized implementation turns that stop on an unevidenced limit or partial progress
- **Unique trigger:** Settled implementation turn whose final message stops without an evidenced blocker or user decision
- **Canonical surface:** completion-enforcement agent_settled hook
- **Overlap decision:** AGENTS.md completion discipline governs intent; roadmap tracks required outcomes
- **Mutation class:** prompt hook with bounded continuation
- **Privacy class:** decision reasons and counters only; no transcript text persisted
- **Success metric:** Implementation turns continue to completion or stop on evidenced blockers without invented budgets
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_COMPLETION_ENFORCEMENT
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
