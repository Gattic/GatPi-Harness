# prompt-suggestions

- **Schema:** 4
- **Owner:** TUI maintainer
- **User problem:** Immediate deterministic editor suggestions with evidence-gated refinement
- **Unique trigger:** Interactive editor session
- **Canonical surface:** prompt suggestion UI
- **Overlap decision:** No model tool; local suggestion is canonical
- **Mutation class:** command/UI hook
- **Privacy class:** metadata-only actions and latency
- **Success metric:** Acceptance/failure bars justify optional refinement
- **Dependency readiness:** optional Hermes
- **Lifecycle:** enabled
- **Default model exposure:** none
- **Rollback/control:** PI_PROMPT_SUGGESTIONS
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
