# tool-surface-router

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Expose a task- and readiness-appropriate model tool subset
- **Unique trigger:** Every submitted user task
- **Canonical surface:** deterministic input hook plus activate_tools for explicit mid-session activation; within a session tools are only added, so the provider prompt cache survives
- **Overlap decision:** All tools remain registered and commands remain available
- **Mutation class:** prompt/tool-surface hook
- **Privacy class:** fixed intent labels and tool names only; no prompt persistence
- **Success metric:** Sessions start on a smaller deterministic surface and every optional tool is reachable by name without widening a restricted surface
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_TOOL_SURFACE_ROUTER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `activate_tools`: **keep**; canonical=deterministic input hook plus activate_tools for explicit mid-session activation; within a session tools are only added, so the provider prompt cache survives; trigger=Every submitted user task; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
