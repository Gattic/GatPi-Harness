# role-sidecar

- **Schema:** 4
- **Owner:** role-runtime maintainer
- **User problem:** Fail-closed typed child role execution
- **Unique trigger:** Isolated role-v2 child only
- **Canonical surface:** role-sidecar tools
- **Overlap decision:** Parent reasoning runtime creates/runs subagents
- **Mutation class:** child-only bounded tools
- **Privacy class:** typed public result plus bounded model/thinking provenance; no task/transcript/provider payload
- **Success metric:** Allowed tools, exact model/thinking parity before provider use, and submit_role_result termination
- **Dependency readiness:** PI_ROLE_SIDECAR=1 contract, resolved expected model/thinking profile
- **Lifecycle:** child-only
- **Default model exposure:** child-only
- **Rollback/control:** PI_ROLE_SIDECAR
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `bash`: **keep-child-only**; canonical=role-sidecar tools; trigger=Isolated role-v2 child only; evidence=unique trigger documented and regression coverage retained
- `role_diff`: **keep-child-only**; canonical=role-sidecar tools; trigger=Isolated role-v2 child only; evidence=unique trigger documented and regression coverage retained
- `role_domain`: **keep-child-only**; canonical=role-sidecar tools; trigger=Isolated role-v2 child only; evidence=unique trigger documented and regression coverage retained
- `role_verify`: **keep-child-only**; canonical=role-sidecar tools; trigger=Isolated role-v2 child only; evidence=unique trigger documented and regression coverage retained
- `submit_role_result`: **keep-child-only**; canonical=role-sidecar tools; trigger=Isolated role-v2 child only; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
