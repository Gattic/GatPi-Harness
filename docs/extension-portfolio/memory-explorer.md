# memory-explorer

- **Schema:** 4
- **Owner:** memory maintainer
- **User problem:** Inspect and govern local memory-like state
- **Unique trigger:** Explicit memory inspection or lifecycle-management request
- **Canonical surface:** memory_explorer for inspection; memory_curator for governed lifecycle
- **Overlap decision:** Obsidian project notes own canonical durable memory
- **Mutation class:** read-only plus checkpointed lifecycle records
- **Privacy class:** sensitive local state; previews and metadata-only exports
- **Success metric:** Mutating lifecycle records require explicit user intent and preserve checkpoints
- **Dependency readiness:** none
- **Lifecycle:** enabled-explicit
- **Default model exposure:** default
- **Rollback/control:** PI_MEMORY_EXPLORER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `memory_curator`: **keep-explicit**; canonical=memory_curator; trigger=explicit user memory-management intent; evidence=governed preview/checkpoint behavior; post-fix adoption insufficient
- `memory_explorer`: **keep**; canonical=memory_explorer for inspection; memory_curator for governed lifecycle; trigger=Explicit memory inspection or lifecycle-management request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
