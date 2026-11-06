# privacy-guard

- **Schema:** 4
- **Owner:** privacy maintainer
- **User problem:** Detect secrets, transcripts, and unsafe runtime state
- **Unique trigger:** Privacy audit or pre-export gate
- **Canonical surface:** privacy_guard
- **Overlap decision:** Semgrep covers code patterns, not runtime-state policy
- **Mutation class:** read-only plus purge preview
- **Privacy class:** findings metadata only
- **Success metric:** Zero actionable findings in managed state
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_PRIVACY_GUARD
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `privacy_guard`: **keep**; canonical=privacy_guard; trigger=Privacy audit or pre-export gate; evidence=unique trigger documented and regression coverage retained

## Scan scope

The default local scan covers all available memory-adjacent runtime roots, including traces, learning-loop state, debug and experiment ledgers, canonical project-memory metadata, curator/maintenance state, evidence, Fix Recall attribution, run-deck state, provenance/execution records, session audit/mining/branches, runtime doctor state, and the roadmap. Results list every configured root by a privacy-safe scope label and mark it available or absent. Missing optional default roots are reported rather than silently omitted; an absent explicitly requested root makes scope completeness false. Raw session bodies remain outside the default content scan, while permission posture is a separate metadata-only scope.

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
