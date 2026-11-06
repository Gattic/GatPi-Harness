# rollout-center

- **Schema:** 4
- **Owner:** release governance maintainer
- **User problem:** Unify technical readiness, policy authority, field proof, rollback controls, and provenance
- **Unique trigger:** Explicit rollout/evidence inspection
- **Canonical surface:** rollout-center command
- **Overlap decision:** extension_ops remains inventory and portfolio authority
- **Mutation class:** read-only command UI
- **Privacy class:** typed metadata, hashes, bounded metrics, and evidence references only
- **Success metric:** Every capability preserves source truth and exposes only the next permitted observation
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_ROLLOUT_CENTER
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
