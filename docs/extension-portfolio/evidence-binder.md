# evidence-binder

- **Schema:** 4
- **Owner:** verification maintainer
- **User problem:** Bind completion claims to concrete verifier evidence
- **Unique trigger:** Verification or handoff claim
- **Canonical surface:** evidence_binder
- **Overlap decision:** verification_center produces project proof
- **Mutation class:** local state
- **Privacy class:** metadata/proof references only
- **Success metric:** Unsupported claims are rejected or marked not-applicable
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_EVIDENCE_BINDER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `evidence_binder`: **keep**; canonical=evidence_binder; trigger=Verification or handoff claim; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
