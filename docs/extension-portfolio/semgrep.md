# semgrep

- **Schema:** 4
- **Owner:** static analysis maintainer
- **User problem:** Pattern and security analysis with explicit readiness
- **Unique trigger:** Security/pattern check
- **Canonical surface:** semgrep_*
- **Overlap decision:** CodeGraph supplements affected tests only
- **Mutation class:** read-only scan
- **Privacy class:** local source to configured scanner; metadata cache
- **Success metric:** Reproducible config scan or precise degradation
- **Dependency readiness:** Semgrep binary/config
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_SEMGREP
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `semgrep_codegraph`: **keep**; canonical=semgrep_*; trigger=Security/pattern check; evidence=unique trigger documented and regression coverage retained
- `semgrep_doctor`: **keep**; canonical=semgrep_*; trigger=Security/pattern check; evidence=unique trigger documented and regression coverage retained
- `semgrep_scan`: **keep**; canonical=semgrep_*; trigger=Security/pattern check; evidence=unique trigger documented and regression coverage retained
- `semgrep_status`: **keep**; canonical=semgrep_*; trigger=Security/pattern check; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
