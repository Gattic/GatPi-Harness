# Multi-Agent Topology Cookbook

## Parallel evidence synthesis

Use `parallel-evidence-synthesis` for explicit read-only architecture research, comparisons, audits, and gap analysis when independent angles are worth the additional model cost.

```text
/topology-run parallel-evidence-synthesis compare the topology runtime with a proposed graph
```

The schema-v3 DAG runs one public scope/decomposition node, then four independent workers (`research`, `compare`, `check`, `gaps`). Workers see the scope result but never sibling results. `audit` receives evidence-only public fields and requires at least three successful workers; failed workers remain explicit inputs. `reduce` is a handler-only deterministic coordinator. With four successful workers the run succeeds; with three it returns `partial`; with fewer it fails because audit is blocked.

The recipe is fully read-only, catalog-visible, and `suggest-only`. It never edits, applies patches, writes memory, publishes, installs, or handles credentials/destructive work. Live sidecar RPC concurrency remains two even though the topology scheduler admits four workers, so normal execution occurs in bounded provider-capacity waves.

Inspect the graph and run state:

```text
/topology-show parallel-evidence-synthesis
/topology-show-run latest
/topology-trace parallel-evidence-synthesis
```

Compact output reports nodes, edges, joins, context/workspace policy, status, duration, evidence counts, and blocked/skipped reasons. Use `run_topology getRun` or `/topology-export` only when the full public packet is required.

## Governed skill intake

Stage an already acquired source locally; the runtime never discovers, clones, fetches, or installs it:

```text
.pi/skill-intake/sources/example/
  manifest.json
  SKILL.md
  LICENSE
```

`manifest.json` must use schema version 1 and include `sourceId`, immutable `revision`, `treeHash`, `contentHash`, pinned `license { spdxId, path, hash }`, `requestedPaths`, `limits { maxFiles, maxBytes }`, and supported `fileTypes`. Hash values use `sha256:<64 lowercase hex>`. Run only through the explicit command:

```text
/skill-intake-validate example
/skill-intake example
/skill-intake-list
/skill-intake-show <candidate-id>
/skill-intake-import <candidate-id>   # imports as untrusted, unapproved candidate only
```

The deterministic front gate runs before a model. Every review branch and the final audit must accept; any hash drift, symlink, path escape, oversized input, unsupported license/type, suspicious instruction, unresolved dependency risk, failed reviewer, or partial join blocks candidate creation. Candidate files are private mode `0600`. A later `/skill-approve` remains a separate human governance action; intake and import never grant advisory retrieval, routing, or publishing approval.

## Planner → executor → reviewer

Use `project-planner-coder-verifier` for small delegated or explicitly invoked implementation tasks. Its planner uses a shared-readonly contract; coder and verifier use detached isolated Git worktrees and return typed public results/proposed changes. It passes task-only context to the planner and summarized dependency output to the coder. The verifier receives the coder's public summary and a hash-validated seed of the proposed patch in its own worktree, so it verifies the proposal without applying it to the parent. A failed, cancelled, timed-out, invalid-terminal, or over-budget node fails the run and prevents `ok`-gated downstream work.

```text
/topology-run project-planner-coder-verifier add a deterministic regression test
```

The canonical router defaults to `/auto-roles off`, and the topology adapter is enabled for explicit manual runs (`PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1`). Setting that flag to `0` disables topology execution. When explicitly enabled, `/auto-roles delegate` executes the selected topology for a matched top-level prompt, waits for settlement, and injects a bounded typed result before the parent turn. `/auto-roles shadow` runs only read-only advisory contracts while the normal parent turn continues. `/auto-roles once <task>`, `auto_role_router run`, and `/topology-run <id> <task>` require the adapter to remain enabled. `suggest` remains available for non-executing recommendations, and legacy `run` warns and maps to `shadow`. Publish, install, credential, and destructive intents never execute through the router; `/auto-roles off` disables classification and injection.

## Join and verification-gated execution

Schema-v3 fan-in nodes may declare `joinPolicy.mode` as `all`, `quorum`, `min-success`, or `best-effort`, with an exact normalized success threshold. Only fully read-only topologies may report partial results. Mutation, verifier/benchmark, roadmap-gated, memory-writing, and patch-producing nodes require `all`; invalid registrations fail before execution.

Use config edge conditions to keep later nodes from running unless upstream results are acceptable.

```json
{
  "edges": [
    { "source": "review", "target": "verify", "condition": "ok" },
    { "source": "verify", "target": "curate", "condition": "no_errors" }
  ]
}
```

Supported string conditions:

- `always` (schedule regardless of upstream status; the run still fails if any node failed)
- `ok`
- `no_errors`
- `confidence>=0.7`
- `status==succeeded`

## Direct roles and reviewer safety

Direct `/subagent --role reviewer ...` and `create_subagent` calls resolve the registered reviewer contract; the role is not a free-form label. The sidecar receives the complete role-v2 contract, resolves the actual child registry, and enables only read/grep/find/ls/`role_diff`/`submit_role_result`. It denies edit/write/bash and succeeds only through typed submission. Successful reviewer submissions require a meaningful summary, supporting evidence, and an explicit passed/failed verdict; placeholder text and unchecked verdicts fail at both child and parent boundaries.

Unknown direct role labels fail unless `create_subagent` also supplies an explicit `systemPrompt`; such custom roles are normalized and restricted to read-only tools. Nodes can reinforce this:

```json
{
  "id": "review",
  "roleId": "reviewer",
  "toolPolicy": {
    "allowedTools": ["read", "grep", "find", "ls", "role_diff", "submit_role_result"],
    "deniedTools": ["edit", "write", "bash"]
  }
}
```

## Memory curator after success

Use `project-memory-curator-after-success` when you want durable context only after verification. Memory writes include topology run, topology ID, and agent provenance.

```text
/topology-run project-memory-curator-after-success summarize the validated change
```

## Subagent-backed node

Use `executionMode: "subagent"` to delegate a model-backed node through the role-v2 subsystem. The registered contract determines `shared-readonly` versus `isolated-worktree`; mutating roles never use the parent `cwd`, while `handler-only` roles remain local handlers. Canonical built-ins and validated project overrides carry per-node contract version, budget, workspace/mutation policy, and output schema. Read-only shadow may launch only contracts whose router policy permits it. Delegate mode may automatically launch isolated contracts only under runtime-v2/R5/isolated-mutation/sidecar containment. A node without a tool, handler, injected executor, or valid subagent mode fails closed.

```json
{
  "id": "worker",
  "roleId": "researcher",
  "executionMode": "subagent",
  "task": "Inspect the isolated branch for {{task}}"
}
```

Smoke command:

```text
/topology-run project-subagent-smoke validate branch-backed topology execution
/subagent-list
```

## Fallback topology

`project-autonomous-coding-workflow` declares `project-reviewer-verifier-gate` as a fallback. If the primary topology fails fast, the fallback is run and the packet records `fallbackOf` and `previousErrors`.

```json
{
  "topologyId": "primary",
  "fallbackTopology": "project-reviewer-verifier-gate"
}
```

## Specialist tasks

For exact artifact acceptance, use `specialist_tasks context` to author a schema-v2
graph, then `preflight` and `run`. Specialists inherit the parent model/effort
unless a per-role `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` override
is configured; there are no task/run budgets or correction caps. Optional local
policy supplies
checkers, not model/spend approvals. `feedback` attaches subjective review to an
artifact without blocking acceptance. No extra UI confirmation is required.
`apply` remains a separate explicit parent operation with executable rechecks.
Pinned BlenderAI dispatch and native/GLB animation checks are documented in
[Explicit specialist tasks](specialist-tasks.md).

## Explicit patch transfer

A completed coder/refactorer run may retain `.pi/subagents/workspaces/<id>/` with patch/hash metadata. Trajectory merge does not apply it:

```text
/subagent-show <id>
/subagent-patch-preview <id>
/subagent-patch-apply <id> --yes
```

Preview checks parent HEAD/status/source fingerprints, changed paths, patch hash/size, and `git apply --check`. Apply is explicit and runs `git diff --check`; failed verification restores touched files. Timed-out/failed/cancelled workspace links are read-only in Chat Focus and remain available to Runtime Cleanup's preview-first retention policy.

## Role-run provenance and timing

Every executed topology node writes a compact schema-v4 `role-run` custom entry to the parent Pi session. It records runtime/contract/result/source versions and source hash, canonical terminal category, typed-result/accounting validity, mutation mode and eligibility reason, selected/effective/fallback model IDs, selected/effective thinking levels and policy sources, status/termination, budgets, exact counters/timing, child-session provenance, workspace/patch/path hashes, and task/result hashes. It contains no provider payload, private reasoning, transcript, or file bodies and does not enter model context.

RPC fanout defaults to two concurrent sidecars. Increase `PI_SUBAGENT_RPC_CONCURRENCY` only when provider capacity is known. Queue wait has its own budget, does not consume child wall-clock time, and `totalDurationMs` is exactly queue plus execution. Tool calls are counted by call ID; results/failures/unmatched IDs are separate.

## Delegation, evidence, and rollback recipe

The canonical default enables manual topology/task tools but disables auto-routing:

```text
PI_ROLE_RUNTIME_VERSION=2
PI_ROLE_MUTATION=isolated
PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1
PI_SPECIALIST_TASKS_ENABLED=1  # task launches also need a reviewed project policy
PI_TOPOLOGY_AUTO_ROUTE=off
PI_ROLE_ROLLOUT_STAGE=R5
PI_ROLE_FIELD_PILOT=0
# PI_ROLE_SIDECAR remains unset in the parent; set 0 only to disable launches.
PI_ROLE_WORKER_SHADOW_CANARY=0
```

Normal-session manual use does not require automatic routing or completion of a benchmark cohort. The stricter task workflow requires a reviewed project policy; see [specialist setup and use](specialist-tasks.md#normal-session-use). For a separately reviewed session that needs automatic delegated execution with explicit parent patch transfer, keep `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1` and set `PI_TOPOLOGY_AUTO_ROUTE=delegate`. Delegate mode owns follow-through in the input lifecycle: it launches the matched topology, waits for its typed result, and injects that result into the parent turn. Child sidecars force routing off to prevent recursion. Mutating nodes work in isolated worktrees and return proposed patches for explicit parent application; automatic delegation never applies a patch to the parent tree.

To collect independent promotion evidence, run the fixed local fixtures:

```bash
node tests/role-runtime-benchmark.test.js
node scripts/benchmark-role-runtime.js --fixture-only --output .pi/role-runtime/benchmarks/latest.json
```

Collect the live read-only cohort explicitly at R0, then request only a stage authorized by both reports:

```text
PI_ROLE_RUNTIME_VERSION=2
PI_ROLE_MUTATION=off
PI_TOPOLOGY_AUTO_ROUTE=suggest
PI_ROLE_ROLLOUT_STAGE=R0
PI_ROLE_FIELD_PILOT=1
PI_ROLE_RUNTIME_BENCHMARK_REPORT=.pi/role-runtime/benchmarks/latest.json
PI_ROLE_RUNTIME_FIELD_REPORT=.pi/role-runtime/audits/latest.json
```

At R0, `PI_ROLE_FIELD_PILOT=1` permits read-only cohort collection. The only automatic exception is the separately guarded `PI_ROLE_WORKER_SHADOW_CANARY=1`: a strict bounded lookup may start one DeepSeek-V4.1-Flash/low worker whose result stays separate from the parent turn. All other field-pilot role calls remain explicit. A deterministic report plus a fresh passing >=30-run live field report is required for evidence-selected R1–R4 when no stage is configured. Explicit stage selection remains visibly separate from that evidence. Roll back immediately with `PI_ROLE_ROLLOUT_STAGE=R0`, mutation/router/canary `off`, sidecar `0`, or runtime version `1`; v2/v3 records and workspaces remain intact for diagnosis.

## Run inspection and maintenance

```text
/topology-runs
/topology-show-run <run-id>
/topology-export latest
/topology-metrics
/topology-doctor
/topology-prune --keep=50 --older-than=14d
/topology-trace <run-id-or-topology-id>
/topology-replay <run-id-or-topology-id>
```

## Starter templates

```text
/topology-template planner-coder-verifier my-new-topology
/topology-template reviewer-verifier-gate my-review-gate
/topology-template parallel-evidence-synthesis my-evidence-graph
```

Templates are written to `.pi/topologies/` and loaded immediately.

## Live safety

Shell-like topology tools block risky commands by default: `rm -rf`, `sudo`, download pipes/redirects, package installs, recursive chmod/chown, and detected write-like actions outside the repo. Only bypass with `PI_TOPOLOGY_ALLOW_UNSAFE=1` when you explicitly accept the risk.
