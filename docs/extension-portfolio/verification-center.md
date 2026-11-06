# verification-center

- **Schema:** 4
- **Owner:** verification maintainer
- **User problem:** Proof-producing multi-verifier project gate
- **Unique trigger:** Completion/publish/release verification
- **Canonical surface:** verification_center
- **Overlap decision:** test_runner supplies focused command execution; visual baselines are separately governed
- **Mutation class:** process control/local evidence
- **Privacy class:** proof metadata, visual hashes/metrics, and bounded outputs; no captured image bodies
- **Success metric:** Evidence reflects all verifier/provider gates truthfully
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_VERIFICATION_CENTER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `verification_center`: **keep**; canonical=verification_center; trigger=Completion/publish/release verification; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
