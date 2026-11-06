# Multi-Agent Topologies

## Specialist task workflow

The `specialist_tasks` layer uses schema-v2 graphs, inherited parent model/effort
with per-role environment overrides honored, `budget: null` producers/reviewers,
uncapped product corrections and exact
artifact-bound executable acceptance. Optional policy configures checkers; human
`feedback` is non-blocking. No extra UI confirmation is required, but parent
`apply` remains a separate explicit operation. Contained BlenderAI dispatch and
native/GLB animation round-trip are available with pinned runtime/add-on bindings.
Automatic routing stays off. Generic topology role budgets below are unchanged.
See [Explicit specialist tasks](specialist-tasks.md).

## Current-state findings

The existing repo already has a branch-backed subagents subsystem, not a blank slate:

- Agent-related modules: `src/subagents.js`, `src/session-branches.js`, `src/integration-boundary.js`, `src/reasoning-runtime.js`, `src/trace-observability.js`, `src/cognitive-memory.js`, `src/layered-context.js`.
- Extension integration: `.pi/extensions/reasoning-runtime/index.ts` registers `/subagent*` commands and a `create_subagent` tool; `extensions/hermes-advisory/index.ts` provides explicit typed, non-mutating Hermes advice.
- Subagents are durable records under `.pi/subagents/records`, results under `.pi/subagents/results`, and child trajectories are `SessionBranchManager` branches of type `multi-agent`.
- Lifecycle states are `created`, `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`.
- Subagents are instantiated through `SubagentService.createSubagent()`, assigned an agent lease on a child branch, and run via `SubagentService.runSubagent()`.
- Live execution uses the single detached Role v2 RPC sidecar path. Replacement-session/fork execution is removed; tests may inject deterministic `SubagentRunner` functions.
- Context is currently mostly prompt/task based plus branch provenance; no explicit topology-level context projection existed.
- Communication is parent-orchestrated through durable result envelopes and explicit merge policies (`none`, `summary_only`, `full_result`, `proposed_patch`).
- Tool policy is recorded in branch state/agent manifests and enforced twice: topology-local wrappers protect handler execution, while subagent-backed roles launch a minimal explicit sidecar with a resolved active-tool allowlist and child-side budget/path guards. Read-only roles use shared-readonly; mutating roles execute in isolated Git worktrees.
- Subagent and topology settlement never starts Hermes or writes durable project memory automatically. Explicit reviewed memory operations remain separate.
- Outputs use `RoleResultEnvelope` v2. Contract-backed RPC success requires a schema-valid terminating `submit_role_result`; untyped output is limited to injected deterministic test runners.
- Observability exists through subagent JSONL events and trace categories (`agent_branching`, `failure_state`, `cancellation`).
- Nested delegation is disabled. Queue wait, model calls, tool calls, result size, and child wall-clock time are bounded; cancellation works while queued or running.
- Execution was individual/sequential command driven, not DAG/graph orchestration.

## Gap analysis

Highest-priority gaps addressed by `src/multi-agent-topologies.js`:

1. Role specialization and registry.
2. Topology registry with nodes/edges/terminal nodes.
3. DAG/sequential/fan-out execution with concurrency limit.
4. Explicit typed `AgentMessage` / `AgentResult` abstraction.
5. Context isolation policies (`full`, `summarized`, `task-only`, `dependency-neighborhood`, `memory-backed`, `isolated-scratch`).
6. Per-agent memory policy and provenance on writes.
7. Explicit, testable tool permission wrapper.
8. Retry, timeout, cancellation checks, and fail-fast/continue-on-error.
9. Structured topology/agent/context/tool/memory trace events.
10. Typed subagent bridge via `SubagentTopologyExecutor`.

Still partial by design: deterministic replay uses trace/result packets but not full provider replay. Execution is fail-closed: a node without a tool, handler, injected `agentExecutor`, or `executionMode: "subagent"` fails with `TOPOLOGY_EXECUTOR_MISSING` instead of echoing its task and claiming success. Topology execution schema v3 now adds explicit join decisions, partial truth, persisted node states, evidence-only projection, and compact graph/run rendering; role contracts and role results remain v2.

## Implemented architecture

`src/role-contracts.js`, `src/role-result-schemas.js`, and `src/multi-agent-topologies.js` add:

- Validated, versioned role contracts and role-specific public result schemas.
- `AgentRoleRegistry` with default roles: coordinator, planner, researcher, coder, reviewer, verifier, refactorer, benchmark, evidence-auditor, memory-curator, tool-specialist, skill-intake-handler, worker, patch-reviewer, integrator, mathematical-researcher, reverse-engineer, 3d-modeler, 3d-critic, reliability-investigator, code-profiler, security-reviewer. The eight specialist additions use `autoRoutePolicy=never`; tool availability is distinct from operational readiness. Every role contract also carries the bounded skill-awareness block from `src/skill-awareness.js`, and each generated `SKILL.md` carries the matching delegation boundary. See [Explicit specialist tasks](specialist-tasks.md) for task graphs, exact executable acceptance and current domain blockers.
- `TopologyRegistry` for code/config/extension-defined topologies.
- `TopologyExecutionEngine` for sequential, fan-out/fan-in, and DAG workflows, including an injected allowlisted `handlerRegistry` for serializable `handlerId` nodes. Registered handlers require a zero-model/zero-tool handler-only role.
- `AgentMessage` and `AgentResult` typed envelopes.
- `ToolPermissionPolicy` and `TopologyMemoryPolicy`.
- `SubagentTopologyExecutor` to run topology nodes through the existing `SubagentService` when `executionMode: "subagent"` is selected.
- `loadTopologyExtension()` for extension modules exporting roles/topologies or `registerMultiAgentTopologies()`.
- `loadTopologyConfig()` / `loadTopologyConfigDir()` for JSON config-defined reusable topologies.
- `replayTrace()` / `filterTraceEvents()` for topology trace inspection and deterministic event replay summaries.
- Persistent topology run packets through `boundary.topologies.getRun()` / `listRuns()` stored under integration storage key `topologies/runs/<runId>`.
- Run export/pruning/metrics through `exportRun()`, `pruneRuns()`, and `metrics()`. Metrics retain overall/legacy counts but compute current reliability only from packets carrying Roles v2 runtime, contract, and result provenance; pre-v2/synthetic packets cannot inflate the current pass rate.
- Dependency-free nested schema validation for objects, arrays, enums, and primitive types.
- Config-friendly edge conditions: `ok`, `no_errors`, `confidence>=N`, and `status==value`.
- Simple object output schema validation via role/node `outputSchema`.
- Retry with alternate roles and fallback topology execution.
- Topology schema-v3 node joins: `all`, `quorum`, `min-success`, and `best-effort`.
- Persisted `pending`, `running`, `succeeded`, `failed`, `cancelled`, `timed-out`, `skipped`, and `blocked` node states.
- Truthful read-only `partial` runs; partial never contributes to the success pass rate.
- `evidence-only` context projection and a shared-readonly `evidence-auditor` role.
- Built-in `parallel-evidence-synthesis`: scope, four orthogonal workers, independent audit, and deterministic coordinator reduction.

`src/integration-boundary.js` exposes a `topologies` adapter so extensions/core can use the topology layer through the same boundary-backed contract as memory, trace, reasoning, and subagents.

## Defining a role

```js
boundary.topologies.registerRole({
  schemaVersion: 2,
  contractVersion: "role-v2",
  roleId: "security-reviewer",
  displayName: "Security Reviewer",
  intent: "review",
  systemPrompt: "A full contract prompt describing objective, allowed/forbidden actions, evidence, output, budgets, and completion criteria...",
  workspacePolicy: "shared-readonly",
  mutationPolicy: "forbidden",
  toolPolicy: { allowedTools: ["read", "grep", "find", "ls", "role_diff", "submit_role_result"], deniedTools: ["edit", "write", "bash"] },
  modelPolicy: { mode: "preferred", preference: "local/DeepSeek-V4.1-Flash-1017", fallback: "inherit", thinkingLevel: "inherit" },
  budget: { maxModelCalls: 6, maxToolCalls: 48, wallClockMs: 180000, maxResultChars: 12000, maxQueueWaitMs: 180000, maxLengthContinuations: 0 },
  inputSchema: null,
  outputSchema: { type: "object", required: ["summary", "findings", "evidence"], properties: { summary: { type: "string" }, findings: { type: "array" }, evidence: { type: "array" } } },
  completionPolicy: { requireSubmittedResult: true, allowEmptySummary: false },
  autoRoutePolicy: "shadow",
  memoryPolicy: "read-only",
  retryPolicy: { maxRetries: 0, backoffMs: 0 },
});
```

## Task-specific inference profiles

Model-backed roles resolve model and thinking separately before an RPC child is spawned. The precedence chain and the canonical role profile table are documented once in [Subagents](subagents.md#inference-precedence); this page covers topology-specific behavior only. Every child receives both `--model` and `--thinking`; the role sidecar verifies the effective profile before provider use and the parent records selected/effective categorical provenance.

Pinned effort must be supported by the delegate model. A model that does not declare `xhigh` or `max` reports those levels as unavailable, and a role pinned above its supported range fails closed at launch instead of silently running at a lower effort. The canonical pins stay within the delegate model's supported levels; raise a pin only after the model declares the level.

Easy bounded read-only delegation uses `worker`; complex roles are not dynamically downgraded. Custom read-only roles default to `local/DeepSeek-V4.1-Flash-1017` and inherit only the parent's effort level. All model-backed delegates use that canonical model by default, independently of the parent model; explicit environment or contract model overrides remain authoritative. Role children launch with a fixed model and do not fail over, so an exhausted or unauthenticated provider blocks every delegation until the pins in `config/harness-defaults.env` change. Specialist `budget: null` producers and reviewers follow the same precedence: they inherit the parent profile only when no role environment override is configured. Model strings may not embed a Pi thinking suffix, and profile mismatch or capability clamping fails closed rather than silently substituting a model or level.

## Planner roadmap responsibility

The registered planner remains shared-readonly and cannot mutate parent roadmap state. Every typed implementation topology requires a bounded public `roadmapPlan` field containing a title plus ordered `{ title, goals[] }` milestones; advisory/legacy planner results may omit it. A `roadmapPlanGate` names the planner and every downstream implementation node. The parent topology runtime atomically applies the hierarchy to Roadmap after planner validation and before any named implementation node starts. Missing plans, invalid hierarchy, unavailable parent scope, or persistence failures stop the topology before implementation.

This separation keeps planning cognition and state mutation explicit: child roles only propose the hierarchy; the owning parent runtime performs and records the state change. Milestones become tasks and goals become nested subtask roadmaps. Direct parent workflows can still apply a plan through `roadmap_update start`, or through explicitly authorized `replace`. The execution engine enforces this for every implementation-capable topology, including raw/custom registrations; omitting an upstream, all-implementation-covering `roadmapPlanGate` fails before a coder or refactorer can start.

Settlement is also parent-owned and bound to the exact applied roadmap ID, run ID, and application fingerprint. Successful topology settlement marks only that delegated planner hierarchy done and resumes its captured parent item; it does not mark the parent item complete or apply an isolated patch. Failed, partial, cancelled, and timed-out settlement marks the delegated hierarchy skipped and shelves it so it cannot become the next nesting target. Stale or unrelated bindings fail closed, and topology packets report both `roadmapApplications` and `roadmapReconciliations`. Child roles never receive parent-roadmap mutation authority.

Automatic delegation preserves a compact `roadmapHandoffs` projection when it returns the topology result to the parent turn. Each entry carries the exact run, roadmap, parent, fingerprint, settlement outcome, and whether further parent reconciliation is required. If the parent continues work after a failed or incomplete delegation, it must inspect and resume that existing roadmap, update its items as work settles, and reconcile those statuses before the final response instead of starting a duplicate plan. A child proposal alone is not evidence that parent-side work is done.

## Defining a topology

```js
boundary.topologies.registerTopology({
  topologyId: "planner-coder-verifier",
  executionMode: "sequential",
  failurePolicy: "fail-fast",
  aggregationPolicy: "last",
  metadata: {
    requiresTypedResults: true,
    roadmapPlanGate: { plannerNodeId: "plan", beforeNodeIds: ["code"] },
  },
  nodes: [
    { id: "plan", roleId: "planner", task: "Plan the work", executionMode: "subagent" },
    { id: "code", roleId: "coder", task: "Implement the plan", executionMode: "subagent" },
    { id: "verify", roleId: "verifier", task: "Run tests", executionMode: "subagent" },
  ],
  edges: [
    { source: "plan", target: "code", condition: "ok" },
    { source: "code", target: "verify", condition: "ok" },
  ],
  terminalNodes: ["verify"],
});
```

Run it:

```js
const result = await boundary.topologies.execute("planner-coder-verifier", { task: "add feature" });
```

### Parallel evidence synthesis

`parallel-evidence-synthesis` is an explicit read-only DAG:

```text
scope
  -> research ┐
  -> compare  ├-> audit (min-success=3, failed inputs retained) -> reduce
  -> check    ┤
  -> gaps     ┘
```

The four workers receive the same public decomposition but no sibling results. The auditor receives `evidence-only` projections rather than worker summaries or private trajectories. The handler-only coordinator emits accepted claims, evidence references, audit decisions, disagreements, rejected claims, unresolved gaps, actions, and coverage. A degraded but sufficient fan-in returns `partial`; fewer than three successful workers blocks audit and fails the run. The recipe has no mutating roles, is catalog-visible, and remains manual/suggest-only.

### Governed skill intake

`governed-skill-intake` is an explicit-only, fail-fast DAG for reviewing a source already staged under `.pi/skill-intake/sources/<source-id>/`:

```text
manifest-validate -> deterministic-filter -> bounded-read -> workflow-extract
  -> objective-score -> candidate-generate
  -> independent-review + security-check + privacy-check + license-check
  -> evidence-audit -> candidate-finalize
```

Before any model call, deterministic handlers require an exact manifest schema, immutable revision, tree/content/license hashes, root-confined relative paths, no symlinks or special files, supported file types/license, and declared hard file/byte limits. High-severity suspicious-instruction or supply-chain findings stop the run. Model nodes are shared-readonly, typed, bounded, and treat staged instructions as untrusted data. Source readers can call only `read` on the exact parent-validated file allowlist; other model nodes can call only typed result submission. Intake sidecars use Pi `--no-session`, so raw file/tool content is not retained in child sessions. Review, audit, and finalization use all-success joins; `partialPolicy` is `forbid`.

Finalization revalidates every source hash and writes only a mode-`0600` private candidate under `.pi/skill-intake/candidates/`. It does not import, route, approve, publish, install, fetch, discover repositories, or write memory. The recipe metadata is `explicitOnly`, `autoRoutePolicy=never`, `publishCapable=false`, and `sourceTrust=untrusted-until-reviewed`; `run_topology` cannot model-invoke it. Use `/skill-intake <source-id>` and then the separate `/skill-intake-import <candidate-id>` command if the private candidate should enter skill synthesis as an unapproved candidate.

## Role resolution and execution truth

`roleId` is a registered execution contract, not a cosmetic label. Direct `/subagent --role ...` and `create_subagent` calls resolve the requested role through the same `AgentRoleRegistry` used by topologies. A registered role contributes canonical ID, full prompt, workspace/mutation/tool/model policy, budgets, typed schema, and completion policy. The child starts with normal discovery disabled and only `extensions/role-sidecar/index.ts` loaded. The sidecar resolves tools against `pi.getAllTools()`, activates exactly the allowed set, independently enforces model/tool/path policy, and registers `role_diff`, approved `role_verify`, and terminating `submit_role_result`. `role_verify` publishes its stable command IDs in the tool schema; the harness regression IDs include `parallel-evidence-benchmark` and `check-all`, arbitrary shell text is never accepted, and repository checks run with sidecar activation and nested-RPC markers reset.

Unknown role labels fail unless the caller supplies an explicit `systemPrompt`. Explicit custom roles are normalized to a bounded kebab-case ID and receive the generic shared-readonly contract (`read`, `grep`, `find`, `ls`, `submit_role_result`); they cannot acquire shell or mutation tools. Empty allowlists mean no tools, while `['*']` is the only all-tools form. Node overrides may narrow a contract; broadening requires a reviewed elevation marker. Omit `role` to use the registered fail-closed `worker` contract.

Topology truth is also fail-closed:

- only `succeeded` is a successful agent status;
- `failed`, `cancelled`, and `timed_out` results become node errors and are retained in the run packet;
- `ok` and `no_errors` edges require a succeeded upstream result;
- `continue-on-error` controls whether independent nodes continue;
- by default any node error makes the final topology status `failed`;
- a fully read-only topology may opt into `partialPolicy: "report"`; only failures explicitly tolerated by a satisfied degraded join can yield `partial`, never `succeeded`;
- protected mutation, verification, roadmap, memory-write, and patch nodes require `joinPolicy: "all"`;
- handler-less non-subagent nodes fail instead of returning their rendered task as output.

Coordinator, memory-curator, and tool-specialist are handler-only contracts and never launch RPC children. Memory-curator accepts only succeeded upstream summaries and writes a provenance-backed verified summary through the topology memory facade.

## Live safety model

Topology tool access is two-layered:

1. Role/node permission policy decides whether an agent may call a tool at all.
2. Live shell-like tools apply a conservative safety block unless `PI_TOPOLOGY_ALLOW_UNSAFE=1` is explicitly set.

Blocked by default:

- recursive/force removal such as `rm -rf`
- `sudo`
- `curl`/`wget` piped or redirected to files/shell
- package installs (`npm install`, `pnpm add`, `yarn add`)
- recursive `chmod -R` / `chown -R`
- write-like actions outside the repo when detected

Memory writes go through the topology memory policy and include provenance (`topologyRunId`, `topologyId`, and `agentId`). Mutating subagent nodes acquire detached worktrees under `.pi/subagents/workspaces/`; failed, cancelled, timed-out, and changed successful runs retain bounded recovery patches. Completed roles append a non-context schema-v4 `role-run` entry containing versions, IDs, canonical policy, selected/effective/fallback models, selected/effective thinking levels, termination, exact counters/timing, child-session provenance, and workspace/patch/path hashes—not transcript or file bodies.

## Restricting tools

Tools are injected into the engine and wrapped per effective role contract. If a role does not explicitly allow a tool, calls fail with `ToolPermissionError` and emit `topology.tool_denied`. Node overrides are validated before context creation, so they cannot expand the wrapper or child allowlist accidentally.

```js
const engine = new TopologyExecutionEngine({
  tools: { read, edit, bash },
  agentExecutor: async ({ context }) => context.tools.read("README.md"),
});
```

## Context and memory policy

Supported context projections are `full`, `summarized`, `evidence-only`, `task-only`, `dependency-neighborhood`, `memory-backed`, and `isolated-scratch`. `evidence-only` forwards bounded typed plans/claims/evidence/audit/gap/action/coverage fields plus status and error provenance; it omits summaries, pre-merged conclusions, transcripts, scratchpads, and private reasoning.

Supported memory policies: `none`, `read-only`, `write-only`, `read-write`, `ephemeral`, `shared-topology`, `private-agent`. Writes receive provenance containing topology run ID, topology ID, and agent/node ID.

## Pi commands and tool

The cognitive automation extension registers:

- `/auto-roles [off|suggest|shadow|delegate|status|route <task>|once <task>|cancel]`
- `/topology-list`
- `/topology-show <id|latest>`
- `/topology-roles`
- `/topology-reload`
- `/topology-run <id> [task]` or `/topology-run <id> --json { ... }`
- `/topology-runs [topology-id]`
- `/topology-show-run <run-id>`
- `/topology-export <run-id|latest> [file]`
- `/topology-prune [--keep=N] [--older-than=Nd] [--topology=id]`
- `/topology-metrics [topology-id]`
- `/topology-doctor`
- `/topology-template [planner-coder-verifier|reviewer-verifier-gate] <id>`
- `/topology-trace [run-id|topology-id]`
- `/topology-replay [run-id|topology-id]`

Model-callable tools:

- `auto_role_router`
  - `operation`: `status`, `classify`, `setMode`, `run`, `cancel`
  - `mode`: `off`, `suggest`, or `run`
  - `task`
- `run_topology`
  - `operation`: `run`, `list`, `show`, `roles`, `trace`, `replay`, `runs`, `getRun`, `export`, `prune`, `metrics`, `doctor`, `template`, `reload`
  - `topologyId`
  - `task`
  - `input`

Configuration directories default to `.pi/topologies` and `topologies`, override with `PI_TOPOLOGY_CONFIG_DIRS=dir1,dir2`. Topology settlement never starts Hermes or writes project memory automatically; durable memory remains an explicit reviewed workflow.

Auto-role routing defaults to `off`, while explicit manual topology execution is enabled in the canonical configuration; routing is also forced off inside child sidecars. `delegate` requires a separate explicit opt-in for top-level interactive sessions. The pure `role-router-v4` classifier separates nouns from requested actions and emits answer, research, plan, review, implement, verify, publish, destructive, or no-route before selecting a topology. Delegate mode executes a matched topology in the input lifecycle, waits for settlement, and injects a bounded typed result into the parent turn. `suggest` remains a non-executing advisory mode, with the optional R0 worker canary below. `shadow` may run a read-only advisory topology while the normal assistant turn continues. Legacy `run` warns and maps to shadow. Opt-outs, question-only prompts, commit/push/publish/install/release, credential operations, and destructive requests never execute through delegation. Matched and skipped `auto-router.decision` entries contain classifier version, intent, topology or recommended role/profile, safety policies, reason code, confidence, prompt hash, mode, classified/matched/execution booleans, worker-canary status, and outcome link—never prompt text.

### R0 safe-worker recommendation

At R0, a prompt receives a `worker` recommendation only when it explicitly says the work is read-only, names a bounded/exact/specific scope, and asks for a simple lookup such as reading, locating, listing, checking, or reporting. Broad searches and investigation, debugging, review, audit, security, correctness, comparison, architecture, verification, benchmark, performance, or mutation work are excluded. Those requests keep their existing topology suggestion or remain unmatched.

The recommendation resolves the registered role through `src/integration-boundary.js`, so the effective profile reflects guarded configuration rather than a duplicated model table. Canonical defaults show `worker` on `local/DeepSeek-V4.1-Flash-1017` with `low` thinking, `shared-readonly` workspace policy, and `forbidden` mutation policy. The worker contract remains `autoRoutePolicy=suggest`.

`PI_ROLE_WORKER_SHADOW_CANARY=1` enables the optional R0/suggest/mutation-off canary; the canonical manual-only configuration sets it to `0`. In its contained mode, an interactive top-level R0 session starts one worker shadow only when the topology adapter is explicitly enabled, the bounded worker classifier matches, the read-only field pilot and sidecar are enabled, mutation is off, the resolved profile is exactly the canonical delegate model at `low` effort, and the role policies remain shared-readonly/mutation-forbidden. The one-node topology is runtime-only, explicit-only, unavailable to generic routing, subject to the normal cooldown/concurrency/cancellation guards, and rechecked by topology and role-runtime containment before the provider call. Child, headless, broad, review, security, credential, publish, destructive, and mutating prompts remain non-executing. Common credential-bearing paths (`.env`, `.ssh`, `.aws`, key files, package credentials, and similar) and indirect positional requests such as “report line 4” also fail the automatic gate.

The parent assistant turn continues independently. The worker result is displayed in a separate notification and is not injected into the parent answer or applied to project files. Compact `auto-router.worker-shadow` entries record stage, prompt hash, exact profile/policies, run links, outcome, and separation status without task or result text. The generic auto-router result entry stores only a result hash for canary runs; ordinary role-run telemetry supplies typed validity and tool-accounting evidence.

Set `PI_ROLE_WORKER_SHADOW_CANARY=0` for immediate rollback to recommendation-only behavior. With the canary disabled, execution remains two explicit user actions:

```text
/subagent-create --role worker <bounded-readonly-task>
/subagent-run latest
```

A provider-free dry-run can explicitly evaluate the contained R0 recommendation controls and prove that the target Git worktree status fingerprint is unchanged:

```bash
node scripts/dry-run-worker-recommendation.js \
  --project /path/to/real-project \
  --task "Read only config/example.json and report the exact version; do not edit files."
```

The JSON result contains only a task hash, the R0/suggest/mutation-off controls, the role/profile recommendation, zero execution/mutation counters, and the before/after status comparison. The dry-run calls the pure classifier directly and never starts the enabled runtime canary.

```text
PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0|1    canonical: 1 for explicit manual runs; 0 disables the adapter
PI_TOPOLOGY_AUTO_ROUTE=off|suggest|shadow|delegate   canonical: off; legacy run maps to shadow with a warning
PI_AUTO_ROLES=off|suggest|shadow|delegate  alias; canonical: off
PI_TOPOLOGY_AUTO_ROUTE_SUBAGENTS=0         do not rewrite node modes; the base topology config decides
PI_TOPOLOGY_AUTO_ROUTE_TOPOLOGY=<id>       preferred implementation topology
PI_TOPOLOGY_AUTO_ROUTE_MIN_CHARS=24
PI_TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS=5000
PI_ROLE_WORKER_SHADOW_CANARY=0|1       canonical: 0; set 1 only for R0/suggest/mutation-off canary mode
PI_ROLE_RUNTIME_VERSION=1|2              immediate v1/v2 selection; no state migration
PI_ROLE_MUTATION=off|isolated             mutating nodes require isolated mode
PI_ROLE_SIDECAR=0|1                       0 disables typed sidecar launches
PI_ROLE_ROLLOUT_STAGE=R0|R1|R2|R3|R4|R5  authoritative when configured; omit for evidence-selected rollout
PI_ROLE_RUNTIME_BENCHMARK_REPORT=.pi/role-runtime/benchmarks/latest.json
```

Without an explicit stage, a deterministic report plus a fresh passing >=30-run exact live read-only field report can select at most R4; either alone leaves R0. An explicitly configured stage is operator authority and is reported separately from evidence eligibility. The canonical configuration enables manual topology execution with role v2 contracts and isolated mutation profiles, but keeps automatic follow-through disabled. Specialist task graphs additionally require the reviewed project policy described in [Explicit specialist tasks](specialist-tasks.md#normal-session-use). Mutating topology nodes use isolated worktrees and return proposed patches for explicit parent preview/application; no automatic route applies a patch to the parent tree. `PI_ROLE_FIELD_PILOT=1` and the worker shadow canary remain available only for the R0/suggest/mutation-off evidence mode. `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, router `off`, `PI_ROLE_RUNTIME_VERSION=1`, `PI_ROLE_ROLLOUT_STAGE=R0`, `PI_ROLE_MUTATION=off`, and sidecar `0` provide immediate rollback while preserving v2/v3 diagnosis state. Inspect stage authority, evidence eligibility, and the legacy/current split with `/doctor-role-runtime`. See [Role runtime benchmark and rollout](role-runtime-benchmark.md).

Run retention is manual by default. Optional command/startup-path pruning is conservative and non-blocking:

```text
PI_TOPOLOGY_AUTO_PRUNE=1
PI_TOPOLOGY_PRUNE_KEEP=100
PI_TOPOLOGY_PRUNE_OLDER_THAN_DAYS=30
```

## Config file example

See `examples/topologies/planner-coder-verifier.json`. Project-local runtime configs are also provided under `.pi/topologies/`:

- `project-planner-coder-verifier`
- `project-reviewer-verifier-gate`
- `project-memory-curator-after-success`
- `project-subagent-smoke`
- `project-autonomous-coding-workflow`

```json
{
  "roles": [{ "roleId": "example-reviewer", "allowedTools": ["read"], "memoryPolicy": "read-only" }],
  "topologies": [{
    "topologyId": "config-planner-coder-verifier",
    "executionMode": "sequential",
    "nodes": [
      { "id": "plan", "roleId": "planner", "executionMode": "subagent" },
      { "id": "code", "roleId": "coder", "executionMode": "subagent" },
      { "id": "verify", "roleId": "verifier", "executionMode": "subagent" }
    ],
    "edges": [{ "source": "plan", "target": "code", "condition": "ok" }, { "source": "code", "target": "verify", "condition": "no_errors" }],
    "terminalNodes": ["verify"]
  }]
}
```

## Output schema, verification-gated edges, alternate retries, fallback

```js
boundary.topologies.registerRole({
  roleId: "json-verifier",
  outputSchema: {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" },
      mode: { enum: ["pass", "fail"] },
      evidence: { type: "array", items: { type: "string" } }
    }
  },
});

boundary.topologies.registerTopology({
  topologyId: "primary",
  fallbackTopology: "safe-fallback",
  nodes: [{ id: "verify", roleId: "json-verifier", retryPolicy: { maxRetries: 1, alternateRoleIds: ["reviewer"] } }],
});
```

## Traces

Trace events are emitted through the existing trace adapter/runtime with names such as:

- `topology.topology.started`
- `topology.agent.started`
- `topology.context.projected`
- `topology.tool_call`
- `topology.tool_denied`
- `topology.memory_read`
- `topology.memory_write`
- `topology.agent.retry`
- `topology.topology.completed`

## Testing

Deterministic tests use injected `agentExecutor` functions and fake tools/memory. See `tests/multi-agent-topologies.test.js`, `tests/topology-policy-conformance.test.js`, and `tests/parallel-evidence-benchmark.test.js`. Run the fixed orchestration comparison with `node scripts/benchmark-parallel-evidence-topology.js`; it measures evidence-category coverage, seeded contradiction/gap detection, unsupported accepted claims, safety, and reducer parity without claiming live model quality. Promotion fixtures and bars are exercised by `node tests/role-runtime-benchmark.test.js` and `node scripts/benchmark-role-runtime.js --fixture-only`. Live command-path validation is available with `scripts/check-topology-tui.sh` and is included in `PI_CHECK_TUI=1 scripts/check-all.sh`.

## Workspace and patch transfer

`handler-only`, `shared-readonly`, and `isolated-worktree` are distinct execution policies. Isolated acquisition records parent HEAD/status/source fingerprints, seeds a detached worktree from staged/unstaged tracked changes plus bounded safe first-party untracked files, and refuses non-Git mutation. Capture produces a bounded binary patch, changed-path hashes, untracked manifest, and verification metadata for every final state. Forbidden paths, sensitive files, escaping symlinks, stale parent state, patch hash/size drift, and apply conflicts fail closed.

`mergePolicy` controls trajectory/result projection only. It never applies a patch. Use `/subagent-patch-preview` and then `/subagent-patch-apply <id> --yes`, or the equivalent service API with `explicit: true` and a verifier. A failed post-apply verifier restores touched parent files byte-for-byte.

## Migration strategy

Existing `/subagent` commands and `create_subagent` keep compatible durable IDs/aliases, while role-v2 fields are canonical. Topology schema-v2 definitions normalize to schema v3 with `joinPolicy: all`, `partialPolicy: forbid`, and compatibility provenance; v2 run packets remain readable and current-role reliability eligible. Trusted external repositories receive validated built-in definitions from `src/role-topologies.js`; project configs may override them only with explicit provenance and role-contract validation. Model roles use `executionMode: "subagent"`; handler-only roles stay local. Every `ok`/`no_errors` edge in a role-v2 topology requires a valid typed upstream result. When the topology adapter is explicitly enabled, delegate mode or `/topology-run` may launch isolated mutation; shadow remains read-only and parent patch application remains explicit. Subagent-backed nodes receive summarized public upstream results without private scratchpads. A verifier node is successful only when its typed `verification.status` is `passed`; `failed` and `unchecked` fail the topology gate. RPC concurrency defaults to two. Diagnostics report exact counters, selected/effective/fallback models, selected/effective thinking levels, queue/execution/total duration, budgets, termination, child-session provenance, and workspace recovery metadata. Run metrics expose current-v2 and legacy cohorts separately; legacy packets do not contribute success reliability. A read-only fallback after failed mutation remains failed with `fallbackOf`, previous errors, and `incompleteMutation` provenance.

## Examples

Run:

```bash
node examples/multi-agent-topologies-example.js
```

It includes:

1. Planner -> Coder -> Verifier
2. Researcher + Coder fan-out -> Reviewer fan-in
3. Debate with two critics and one judge
4. File map-reduce
5. Memory curator after successful run
