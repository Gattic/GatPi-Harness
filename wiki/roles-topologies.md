# Roles, subagents, and topologies

Typed delegation is optional and manually driven by default: automatic routing is off, mutating roles return isolated patches, and applying a patch to the parent tree is always an explicit, verified action.

## Roles v2 topology defaults and evidence

Typed roles use validated contracts, RPC sidecars, isolated proposed-patch mutation, and transcript-free parent-session provenance. The canonical environment enables explicit manual topology/task tools with `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1` and `PI_SPECIALIST_TASKS_ENABLED=1`, while automatic routing stays `PI_TOPOLOGY_AUTO_ROUTE=off`. Specialist tasks inherit the parent model/effort unless a per-role `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` override is configured, with no task/run budgets or correction cap. Optional project policy configures executable checkers; missing policy supplies dossier verification. Artifact-linked human feedback is non-blocking, and no extra UI confirmation is required. See [normal-session specialist use](../docs/specialist-tasks.md#normal-session-use). Child routing remains disabled to prevent recursion, and isolated role patches never reach the parent tree automatically. Independent evidence-selected promotion remains gated by the deterministic fixture benchmark:

```bash
node tests/role-runtime-benchmark.test.js
node scripts/benchmark-role-runtime.js --fixture-only
```

Runtime selection and rollback use `PI_ROLE_RUNTIME_VERSION`, `PI_ROLE_MUTATION`, `PI_MULTI_AGENT_TOPOLOGIES_ENABLED`, `PI_TOPOLOGY_AUTO_ROUTE`, `PI_ROLE_SIDECAR`, and `PI_ROLE_ROLLOUT_STAGE`. Role v2 contracts and profiles remain configured at explicitly selected R5 with isolated mutation for reviewed operator use, with manual topology execution available in new sessions and the auto-router inactive. Separately opting into `delegate` mode automatically executes matched topologies, waits for settlement, and injects their typed results into the parent turn. Mutating roles return isolated proposed patches, and applying one to the parent remains an explicit hash/conflict/verification-checked action. Automatic evidence-based promotion remains capped at R4 when no stage is configured; the explicit configured stage is reported separately from evidence eligibility. Set `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, `PI_TOPOLOGY_AUTO_ROUTE=off`, `PI_ROLE_ROLLOUT_STAGE=R0`, `PI_ROLE_MUTATION=off`, or `PI_ROLE_RUNTIME_VERSION=1` for immediate state-preserving rollback. `/doctor-role-runtime` reports stage authority, evidence eligibility, mutation mode, router mode, and legacy/current state split. See [Role runtime benchmark and rollout](../docs/role-runtime-benchmark.md), [Phase 7 release scorecard](../docs/phase7-release-scorecard.md), [Subagents](../docs/subagents.md), and [Topology cookbook](../docs/topology-cookbook.md).

Session/role state is private by default. Historical Pi session permissions are migrated only through a bounded dry-run-first explicit apply; ordinary sessions are never automatically archived or deleted. Role cleanup is manifest-first and preserves active/failure/recovery/debug-referenced evidence.

## Further reading

- [`docs/subagents.md`](../docs/subagents.md) — branch-backed subagents, lifecycle, merge policies, command/tool API, private state, and TUI regression validation.
- [`docs/multi-agent-topologies.md`](../docs/multi-agent-topologies.md) — Roles v2 registry, topology DAG execution, joins, policy enforcement, and replay.
- [`docs/topology-cookbook.md`](../docs/topology-cookbook.md) — production recipes for parallel and sequential delegation.
- [`docs/adr-parallel-evidence-topology.md`](../docs/adr-parallel-evidence-topology.md) — accepted safety and privacy boundaries for fan-out/fan-in.


---

[Back to the README](../README.md) · [Wiki index](README.md)
