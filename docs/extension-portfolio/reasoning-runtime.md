# reasoning-runtime

- **Schema:** 4
- **Owner:** reasoning runtime maintainer
- **User problem:** Reasoning context, typed roles, artifact-bound specialist tasks, plan fan-out, topology recipes, and skill synthesis
- **Unique trigger:** Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance
- **Canonical surface:** create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution
- **Overlap decision:** Roadmap owns visible plan state; role-sidecar executes child contracts
- **Mutation class:** orchestration/preview-apply
- **Privacy class:** redacted artifacts and metadata-only telemetry
- **Success metric:** Typed outcomes, bounded context, and verifier parity
- **Dependency readiness:** none
- **Lifecycle:** enabled
- **Default model exposure:** default
- **Rollback/control:** PI_REASONING_RUNTIME_ENABLED
- **Migration path:** no destructive migration; restore prior exposure through the documented control

## Tool decisions

- `auto_role_router`: **keep**; canonical=create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution; trigger=Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance; evidence=unique trigger documented and regression coverage retained
- `create_subagent`: **keep**; canonical=create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution; trigger=Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance; evidence=unique trigger documented and regression coverage retained
- `run_topology`: **keep**; canonical=create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution; trigger=Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance; evidence=unique trigger documented and regression coverage retained
- `skill_synthesis`: **keep**; canonical=create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution; trigger=Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance; evidence=unique trigger documented and regression coverage retained
- `specialist_tasks`: **keep**; canonical=create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution; trigger=Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance; evidence=unique trigger documented and regression coverage retained

## Evidence boundary

- Classified interactive sample: 0 sessions
- Classified observation: 0.48/30 days
- Usage: insufficient-data; adoption=n/a
- Trigger-eligible utility: insufficient-data; eligible=0; valued=0
- Lifecycle authority: no-go-deferred

Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.
