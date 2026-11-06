# safe-try

- **Schema:** 4
- **Owner:** safety maintainer
- **User problem:** Checkpoint and rollback risky working-tree attempts
- **Unique trigger:** Before an explicitly risky edit
- **Canonical surface:** safe_try
- **Overlap decision:** ast_refactor owns its narrower mechanical-edit checkpoints
- **Mutation class:** preview-apply rollback
- **Privacy class:** working-tree hashes/paths
- **Success metric:** Worse attempts restore tracked state without deletion
- **Dependency readiness:** Git repository
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_SAFE_TRY
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `safe_try`: **keep**; canonical=safe_try; trigger=Before an explicitly risky edit; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
