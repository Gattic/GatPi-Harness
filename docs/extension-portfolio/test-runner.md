# test-runner

- **Schema:** 4
- **Owner:** verification maintainer
- **User problem:** Infer and execute repository-defined focused tests
- **Unique trigger:** After code edits
- **Canonical surface:** test_runner
- **Overlap decision:** build/test_project handle pinned native project suites
- **Mutation class:** process control
- **Privacy class:** captured command evidence; bounded logs
- **Success metric:** Real commands pass/fail and no-command is not-applicable
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_TEST_RUNNER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `test_runner`: **keep**; canonical=test_runner; trigger=After code edits; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
