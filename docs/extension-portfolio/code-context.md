# code-context

- **Schema:** 4
- **Owner:** retrieval maintainer
- **User problem:** Progressive task-focused repository context
- **Unique trigger:** Unfamiliar code localization
- **Canonical surface:** code_context
- **Overlap decision:** CodeGraph/LSP remain provider diagnostics
- **Mutation class:** read-only
- **Privacy class:** source returned on demand; telemetry metadata-only
- **Success metric:** Relevant symbols localized within budget
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** retain-current-settings
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `code_context`: **keep**; canonical=code_context; trigger=Unfamiliar code localization; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
