# output-compactor

- **Schema:** 4
- **Owner:** runtime maintainer
- **User problem:** Compact oversized structured results before model/TUI consumption
- **Unique trigger:** Oversized selected structured result or explicit command
- **Canonical surface:** tool-specific result rendering plus measured canary hook
- **Overlap decision:** Manual model resend duplicates payload already in context
- **Mutation class:** command/runtime hook
- **Privacy class:** metadata-only size and latency counters; no input/output persistence
- **Success metric:** Canary results shrink without reliability or context regressions
- **Dependency readiness:** none
- **Lifecycle:** experimental-canary
- **Default model exposure:** command-only
- **Rollback/control:** PI_OUTPUT_COMPACTOR_MODE=off
- **Migration path:** keep command and state; restore model exposure only through the documented opt-in

## Tool decisions

- `output_compactor`: **experimental-command-only**; canonical=tool-specific result rendering plus measured automatic canary; trigger=manual compatibility testing only; automatic canary is independently governed; evidence=post-fix observation window insufficient; command surface retained; opt-in=`PI_OUTPUT_COMPACTOR_MODEL_TOOL=1`

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
