# skill-lazy

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** User-scope skill descriptions dominate every session prompt
- **Unique trigger:** Session prompt setup with user-scope skills
- **Canonical surface:** before_agent_start reduction of options.skills to project skills plus a compact global name index
- **Overlap decision:** Pi owns skill discovery; tool-surface-router owns tools
- **Mutation class:** prompt hook
- **Privacy class:** skill names and locations only; no skill bodies persisted
- **Success metric:** Startup prompt carries project skills fully described and a lazy index for the global catalog
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_SKILL_LAZY
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
