# codemode

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Compose deterministic tool chains and filter intermediate results outside model turns
- **Unique trigger:** Independent read batches or dependent read/filter workflows
- **Canonical surface:** native Pi codemode in hybrid on mode
- **Overlap decision:** Direct tools remain available; scripts do not replace reasoning or verification authority
- **Mutation class:** bounded read-oriented tool composition
- **Privacy class:** models and persistent store disabled; metadata-only lifecycle telemetry
- **Success metric:** Native conformance passes and paired benefit is measured without fabricated evidence
- **Dependency readiness:** Pi public createCodemodeExtension and QuickJS runtime
- **Lifecycle:** core
- **Default model exposure:** default
- **Rollback/control:** PI_CODEMODE
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `codemode`: **keep**; canonical=native Pi codemode in hybrid on mode; trigger=Independent read batches or dependent read/filter workflows; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
