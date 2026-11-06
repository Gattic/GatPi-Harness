# docs-lookup

- **Schema:** 4
- **Owner:** documentation tooling maintainer
- **User problem:** Version-matched local/project/package documentation
- **Unique trigger:** API question with local docs
- **Canonical surface:** docs_lookup
- **Overlap decision:** read accesses Pi framework docs outside project confinement
- **Mutation class:** read-only
- **Privacy class:** local docs returned on demand
- **Success metric:** Answer cites installed/local documentation
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_DOCS_LOOKUP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `docs_lookup`: **keep**; canonical=docs_lookup; trigger=API question with local docs; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
