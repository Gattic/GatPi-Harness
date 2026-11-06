# test-gap-planner

- **Schema:** 4
- **Owner:** verification maintainer
- **User problem:** Identify changed behavior without adequate tests
- **Unique trigger:** Coverage planning after edits
- **Canonical surface:** test_gap_planner
- **Overlap decision:** test_runner executes inferred commands
- **Mutation class:** read-only/preview skeleton
- **Privacy class:** source paths and test provenance
- **Success metric:** High-risk gaps receive focused test plans
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_TEST_GAP_PLANNER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `test_gap_planner`: **keep**; canonical=test_gap_planner; trigger=Coverage planning after edits; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
