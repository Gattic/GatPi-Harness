# extension-ops-center

- **Schema:** 4
- **Owner:** extension product maintainer
- **User problem:** Reconcile extension inventory, lifecycle, telemetry, and conflicts
- **Unique trigger:** Extension operations or portfolio review
- **Canonical surface:** extension_ops
- **Overlap decision:** project_intelligence profiles the wider repository
- **Mutation class:** read-only/docs generation
- **Privacy class:** metadata-only inventory/telemetry
- **Success metric:** Zero unexplained runtime/source discrepancies
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_EXTENSION_OPS
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `extension_ops`: **keep**; canonical=extension_ops; trigger=Extension operations or portfolio review; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
