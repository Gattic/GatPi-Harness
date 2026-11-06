# build-runner

- **Schema:** 4
- **Owner:** build tooling maintainer
- **User problem:** Repository-pinned build and test execution
- **Unique trigger:** Build or native project test request
- **Canonical surface:** build_project/test_project
- **Overlap decision:** test_runner is canonical for inferred focused commands
- **Mutation class:** process control
- **Privacy class:** local command evidence; bounded output
- **Success metric:** Pinned builds/tests return structured terminal status
- **Dependency readiness:** flock (util-linux)
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_BUILD_RUNNER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `build_project`: **keep**; canonical=build_project/test_project; trigger=Build or native project test request; evidence=unique trigger documented and regression coverage retained
- `test_project`: **keep**; canonical=build_project/test_project; trigger=Build or native project test request; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
