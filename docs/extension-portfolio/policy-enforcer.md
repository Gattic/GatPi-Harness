# policy-enforcer

- **Schema:** 4
- **Owner:** safety maintainer
- **User problem:** Central policy checks and approval grants
- **Unique trigger:** Risky path/command/tool action
- **Canonical surface:** policy_gate/policy_enforcer
- **Overlap decision:** safe_try snapshots state but does not authorize actions
- **Mutation class:** policy/approval state
- **Privacy class:** metadata-only grants
- **Success metric:** Unsafe actions block unless narrowly approved
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_POLICY_ENFORCER
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `policy_enforcer`: **keep**; canonical=policy_gate/policy_enforcer; trigger=Risky path/command/tool action; evidence=unique trigger documented and regression coverage retained
- `policy_gate`: **keep**; canonical=policy_gate/policy_enforcer; trigger=Risky path/command/tool action; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
