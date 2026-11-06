# 00-harness-defaults

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Apply canonical guarded harness environment defaults before other extensions load
- **Unique trigger:** Harness extension startup
- **Canonical surface:** config/harness-defaults.env
- **Overlap decision:** Explicit process environment values always win
- **Mutation class:** startup configuration
- **Privacy class:** fixed non-secret environment values only
- **Success metric:** Every harness extension observes the same reviewed defaults and rollback overrides
- **Dependency readiness:** none
- **Lifecycle:** core
- **Default model exposure:** none
- **Rollback/control:** config/harness-defaults.env
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
