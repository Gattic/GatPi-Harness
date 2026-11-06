# ci-pr-companion

- **Schema:** 4
- **Owner:** CI tooling maintainer
- **User problem:** Read-only CI and pull-request triage
- **Unique trigger:** Explicit CI/PR inspection
- **Canonical surface:** ci_pr_companion
- **Overlap decision:** gitevidence is canonical for local Git state
- **Mutation class:** read-only
- **Privacy class:** provider metadata; no credentials persisted
- **Success metric:** CI findings map to actionable local verification
- **Dependency readiness:** gh when available
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_CI_PR_COMPANION
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `ci_pr_companion`: **keep**; canonical=ci_pr_companion; trigger=Explicit CI/PR inspection; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
