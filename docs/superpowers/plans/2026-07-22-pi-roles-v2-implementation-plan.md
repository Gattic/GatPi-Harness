# Pi Roles v2 Implementation and Rollout Plan

> **Status:** Proposed. Evidence-backed by the 2026-07-22 session audit. Keep automatic routing in `suggest` mode until the isolation and execution-truth gates in this plan pass.
>
> **Execution note:** This is a program-level roadmap spanning `pi-harness` and the source-backed `Gattic/GatPi` fork. Expand and review one batch at a time before editing. Do not execute Batches 0-7 as one change set, and do not use the current mutating auto-role path to implement this plan.

**Goal:** Replace the current loosely specialized, timeout-prone role sidecars with a versioned role runtime that has truthful outcomes, enforced budgets, explicit tool and workspace policies, typed results, safe routing, useful topology defaults, private state, and measurable rollout gates.

**Architectural principle:**

> A Pi role is a delegated execution contract, not a cosmetic label and not a hidden identity switch. A role succeeds only when its typed result validates, and a mutating role never writes directly into the parent working tree.

**Canonical implementation:** `src/subagents.js`, `src/multi-agent-topologies.js`, and `.pi/extensions/reasoning-runtime/index.ts`. `src/cognitive-architecture.js` remains compatibility-only and must not become a second role orchestrator.

**Repository verification:** Focused harness tests run with `node tests/<name>.test.js`; the full harness gate is `bash scripts/check-all.sh`, with TUI coverage enabled by `PI_CHECK_TUI=1`. Pi fork changes use the scripts in `~/pi/packages/coding-agent/package.json`: focused Vitest, then package build/test, then the harness fork setup/drift checks.

---

## 1. Evidence Baseline and Claim Boundary

The 2026-07-22 audit found:

- 1,441 global Pi session files, approximately 520 MB, across 64 working directories.
- Structurally healthy v3 JSONL: zero parse failures, duplicate IDs, orphan tree parents, or timestamp-order violations in 1,440 closed sessions.
- 273 `create_subagent` calls and 174 stored execution envelopes.
- 122 of 174 execution envelopes timed out.
- The post-hardening cohort contained 16 `role-run` entries: 15 timed out and one was falsely marked succeeded after a terminal child context-overflow error.
- Those 16 children made 1,313 actual tool calls, averaging 82 per child; five waited in the process-local RPC queue, and p95 total latency was approximately 600 seconds.
- A timed-out coder completed three successful mutating tool calls in the shared parent working tree.
- `budget.maxSteps=8` was not enforced; one child made 16 model calls and 120 actual tool calls.
- Diagnostics reported 240 tool calls for those 120 executions because both calls and results were counted.
- Current role tool policies were enforced in the post-hardening cohort, but role prompts, output validation, model policies, and tool availability remain shallow or inconsistent.
- 45 automatic suggestions appeared in 15 sessions. They were advisory only, but several status/questions were routed to implementation, while some implementation tasks were routed to a reviewer/verifier topology with no coder.
- Only `pi-harness` had topology configs; the other 63 observed working directories could not select the project defaults.
- Current topology metrics report 3/3 historical success, but two runs completed in 4-8 ms without subagent/model/tool provenance and predate fail-closed role execution.
- 1,439 of 1,441 global session files were mode `0644`; most session directories were `0755`. The harness hardens newly active sessions, but Pi core still creates files according to the process umask.

Do not copy full transcripts into fixtures or planning artifacts. New regression fixtures should preserve only redacted event shapes, counts, stop reasons, hashes, and synthetic task text.

### Open debug threads and closure gates

| Thread | Confirmed issue | Close only when |
|---|---|---|
| `rpc-role-run-succeeds-despite` | Terminal assistant error can persist as `succeeded` | Terminal `error`, `aborted`, invalid/empty final output, and unhandled `length` all produce non-success results in unit and live RPC smokes |
| `subagent-maxsteps-budget-is-not` | `maxSteps` is metadata-only | Parent and child fail-safes stop model/tool execution at the configured limits, with deterministic diagnostics |
| `subagent-diagnostics-double-count-tool` | Tool executions are counted twice | Diagnostics exactly match tool-call IDs; calls, results, failures, and unmatched IDs are separate metrics |
| `timed-out-rpc-coder-mutates` | Timed-out coder writes to parent cwd | A timed-out mutating role leaves the parent tree byte-identical and retains an isolated recovery workspace/patch |

Every implementation attempt must be recorded against the relevant thread. Do not repeat the read-only audit attempts already recorded.

---

## 2. Non-Negotiable Invariants

1. **Delegation, not identity switching.** Documentation and UI must say when the parent remains active, when work is delegated, and when an explicit session replacement occurs.
2. **Truthful success.** Only a schema-valid final role result with an accepted terminal condition is `succeeded`.
3. **No shared-cwd mutation.** Coder, refactorer, dependency-update, and other mutating roles run in isolated workspaces and return proposed changes.
4. **Explicit parent application.** Applying a role patch to the parent requires hash checks, conflict detection, verification, and an explicit parent action. `mergePolicy` never implies filesystem mutation.
5. **Enforced budgets.** Wall-clock, model-call, tool-call, output-size, queue, and nesting budgets are operational controls, not record metadata.
6. **Fail-closed tools.** An empty allowlist means no tools. Unknown or unavailable tool names fail role registration or diagnostics; they do not silently disappear.
7. **Typed outputs.** Planner, researcher, reviewer, coder, verifier, benchmark, and custom roles have validated public result envelopes. Private reasoning and full child transcripts are never required outputs.
8. **No hidden mutating auto-run.** Automatic typed prompts may be suggested or shadowed read-only. Mutating delegation is explicit and cannot run concurrently with an ordinary parent implementation turn.
9. **Versioned evidence.** Role contracts, results, provenance entries, topology runs, and metrics carry schema/runtime versions. Legacy synthetic runs do not count toward current reliability.
10. **Private bounded state.** Session, role, workspace, result, trace, and benchmark state is permission-restricted, bounded, and retention-aware.
11. **Preserve model-side reasoning architecture.** Roles produce public artifacts and evidence; they do not reintroduce hard-coded hidden planner/executor cognition into the harness.

---

## 3. Target Architecture

```text
User task / explicit topology request
                 |
        task-intent classifier
                 |
        versioned RoleContract
     +-----------+-------------+
     |                         |
shared-readonly            isolated-worktree
research/review            code/refactor/verify
     |                         |
     +------ workspace lease --+
                 |
      minimal Pi RPC sidecar
  (--no-extensions + explicit role-sidecar)
                 |
 child + parent budget enforcement
                 |
       typed result submission
                 |
 terminal/result/schema validator
                 |
 topology gate + compact role-run v2
                 |
 explicit patch preview/apply/verify
```

### 3.1 `RoleContract` v2

Add one canonical contract shape, validated at registration:

```js
{
  schemaVersion: 2,
  contractVersion: "role-v2",
  roleId: "reviewer",
  displayName: "Reviewer",
  intent: "review",
  systemPrompt: "...",
  workspacePolicy: "handler-only|shared-readonly|isolated-worktree",
  mutationPolicy: "forbidden|proposed-patch|isolated-only",
  toolPolicy: {
    allowedTools: ["read", "grep", "find", "ls", "role_diff", "submit_role_result"],
    deniedTools: ["edit", "write", "bash"]
  },
  modelPolicy: {
    mode: "inherit|preferred|fixed",
    preference: null,
    fallback: "inherit"
  },
  budget: {
    maxModelCalls: 6,
    maxToolCalls: 48,
    wallClockMs: 180000,
    maxResultChars: 12000,
    maxQueueWaitMs: 180000
  },
  inputSchema: null,
  outputSchema: { /* role-specific public result */ },
  completionPolicy: {
    requireSubmittedResult: true,
    allowEmptySummary: false
  },
  autoRoutePolicy: "never|suggest|shadow|delegate"
}
```

Rules:

- `allowedTools: []` means no tools; `allowedTools: ["*"]` is the only all-tools form.
- Tool resolution occurs against the actual child tool registry before launch. Required missing tools fail before provider usage.
- Node overrides may only narrow a role contract unless a separately reviewed topology explicitly declares an elevation.
- Unknown direct roles remain possible only through an explicit custom prompt, `shared-readonly`, the fixed read-only tool set, and the generic typed result schema.
- Model preference is configurable per role, but no provider/model ID is hard-coded as a product requirement. Inheritance remains the portable default.

### 3.2 `RoleResultEnvelope` v2

```js
{
  schemaVersion: 2,
  contractVersion: "role-v2",
  subagentId: "sub_...",
  roleId: "reviewer",
  status: "succeeded|failed|cancelled|timed_out",
  termination: {
    code: "submitted|provider_error|output_limit|budget_model_calls|budget_tool_calls|wall_clock|cancelled|invalid_result",
    stopReason: "stop|length|toolUse|error|aborted|null",
    message: "bounded public diagnostic"
  },
  summary: "bounded public summary",
  findings: [],
  evidence: [],
  artifacts: [],
  proposedPatch: null,
  verification: { status: "unchecked|passed|failed", evidence: [] },
  diagnostics: {
    modelCalls: 0,
    toolCalls: 0,
    toolResults: 0,
    toolFailures: 0,
    unmatchedToolCallIds: [],
    queueWaitMs: 0,
    executionDurationMs: 0,
    totalDurationMs: 0,
    budgets: {},
    workspace: {},
    childSessionFile: null
  }
}
```

The child should finish through a dedicated `submit_role_result` tool registered by a minimal explicit sidecar extension. That tool validates the role schema and returns `terminate: true`. Plain assistant text is retained as a compatibility fallback during migration but does not qualify as v2 success unless parsed and validated.

### 3.3 Initial default role matrix

These are conservative launch defaults, to be tuned only from benchmark evidence:

| Role | Workspace | Effective tools | Initial budget | Required output | Automatic use |
|---|---|---|---|---|---|
| coordinator | handler-only | none | local handler | aggregation decision | never as RPC role |
| planner | shared-readonly | read/grep/find/ls | 4 model / 24 tool / 120s | scoped plan, assumptions, risks, acceptance checks | suggest/shadow |
| researcher | shared-readonly | read/grep/find/ls | 6 / 48 / 180s | findings with paths/evidence/uncertainty | suggest/shadow |
| reviewer | shared-readonly | read/grep/find/ls/`role_diff` | 6 / 48 / 180s | severity-ranked findings and verdict | suggest/shadow |
| coder | isolated-worktree | read/grep/find/ls/edit/write/bash | 8 / 64 / 300s | change summary, patch, checks, residual risks | explicit delegate only |
| verifier | isolated-worktree | read/grep/find/ls/approved verification runner | 8 / 64 / 300s | commands, outcomes, evidence, verdict | explicit topology or shadow if non-mutating |
| refactorer | isolated-worktree | coder set | 8 / 64 / 300s | invariant-preserving patch and checks | explicit delegate only |
| benchmark | isolated-worktree | read + approved benchmark runner | 8 / 64 / 300s | before/after metrics and validity notes | explicit only |
| memory-curator | handler-only | memory facade | local handler | provenance-backed durable summary | gated after verified success |
| tool-specialist | handler-only | node-supplied narrow tool | node budget | tool-specific schema | explicit topology only |
| worker | shared-readonly by default | explicit caller subset | 6 / 48 / 180s | generic typed result | never automatically mutable |

A mutating custom worker must explicitly request `isolated-worktree`; it cannot elevate itself through a prompt.

---

## 4. Execution Program

### Batch 0 — Immediate Containment, Reproducible Baseline, and Version Boundary

**Goal:** Prevent new unsafe automatic mutation while preserving current manual workflows and turning the one-off audit into reproducible evidence.

**Files:**

- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Create: `scripts/audit-role-runtime.js`
- Create: `tests/role-runtime-audit.test.js`
- Modify: `docs/runtime-configuration.md`
- Modify: `docs/subagents.md`
- Modify: `docs/multi-agent-topologies.md`
- Modify: `docs/topology-cookbook.md`

#### Tasks

- [ ] Keep the default `PI_TOPOLOGY_AUTO_ROUTE=suggest` and explicitly refuse automatic execution of any topology containing a mutating role while role runtime v2 is unavailable.
- [ ] Add a clear warning to `/auto-roles run` and `auto_role_router operation=run`; during containment, permit only read-only shadow topologies or require an explicit `/topology-run` command.
- [ ] Add `roleRuntimeVersion`, contract version, and result schema version to `/topology-doctor` and `/auto-roles status`.
- [ ] Classify persisted topology packets without v2 provenance as `legacy`; exclude them from current reliability rates while keeping them inspectable.
- [ ] Turn the audit logic into `scripts/audit-role-runtime.js`: bounded scans, no transcript output, current-session exclusion, child-session provenance checks, permission summary, exact tool-call accounting, and JSON/Markdown reports under ignored `.pi/role-runtime/audits/`.
- [ ] Add synthetic fixtures for the four confirmed bugs without copying user prompts, source contents, or child transcripts.
- [ ] Document that current RPC subagents are context-isolated but not filesystem-isolated until Batch 3.

#### Verification

```bash
node tests/role-runtime-audit.test.js
node tests/auto-role-router-source.test.js
node tests/topology-extension-source.test.js
node scripts/audit-role-runtime.js --sessions ~/.pi/agent/sessions --output .pi/role-runtime/audits/baseline.json
```

#### Stop condition

Do not enable mutating automatic routes. Do not reinterpret or delete legacy runs. The baseline report must reproduce corpus counts within expected active-session drift without exposing transcript content.

---

### Batch 1 — Execution Truth, Exact Diagnostics, and Enforced Budgets

**Goal:** Resolve three open execution/telemetry debug threads before changing role prompts or topology behavior.

**Files:**

- Modify: `src/subagents.js`
- Create: `src/subagent-result-validator.js`
- Modify: `tests/subagents.test.js`
- Create: `tests/subagent-rpc-terminal-status.test.js`
- Create: `tests/subagent-budget-enforcement.test.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `docs/subagents.md`
- Modify: `docs/runtime-configuration.md`

#### Tasks

- [ ] Define accepted terminal truth for v1 compatibility: a terminal assistant `error`/`aborted`, empty final output, rejected prompt, malformed RPC, or unhandled `length` is non-success. A bounded continuation policy may handle `length`, but only within the same model/tool/wall-clock budgets.
- [ ] Inspect both `agent_end` and returned messages. Persist the final assistant stop reason and bounded error code.
- [ ] Replace `messageDiagnostics()` with ID-based accounting: count assistant `toolCall` blocks once; track matching results, result failures, and unmatched IDs separately.
- [ ] Rename ambiguous fields in v2 diagnostics while reading old snake_case fields for compatibility.
- [ ] Interpret existing `maxSteps` as `maxModelCalls` during migration. Add explicit `maxModelCalls`, `maxToolCalls`, `maxQueueWaitMs`, and `maxResultChars`.
- [ ] Add dual-layer enforcement: the child role-sidecar will block over-budget operations in Batch 2, while the parent RPC parser independently counts events and aborts/terminates on overrun.
- [ ] Ensure queue wait does not consume child execution budget, but total duration reports queue plus execution exactly.
- [ ] On any budget breach, request RPC abort, send SIGTERM, then SIGKILL after the existing grace period; retain diagnostics and child session location.
- [ ] Make result persistence idempotent so late process events cannot overwrite a final timeout/cancellation.
- [ ] Record each new implementation/test attempt in the matching debug thread; resolve `rpc-role-run-succeeds-despite`, `subagent-maxsteps-budget-is-not`, and `subagent-diagnostics-double-count-tool` only after regression tests pass.

#### Required regression cases

- terminal assistant `error` with `agent_end`
- terminal `aborted`
- terminal `length` with and without bounded continuation
- empty assistant output
- valid final output
- valid terminating structured tool result
- model-call budget reached exactly and exceeded by one
- tool-call budget reached exactly and exceeded by a parallel batch
- queue wait followed by full execution budget
- parent cancellation while queued and while running
- duplicate/late `agent_end`
- tool result without call and call without result

#### Verification

```bash
node tests/subagents.test.js
node tests/subagent-rpc-terminal-status.test.js
node tests/subagent-budget-enforcement.test.js
node tests/multi-agent-topologies.test.js
node tests/subagent-tool-source.test.js
```

#### Exit gate

- 100% of synthetic terminal-error cases are non-success.
- Actual tool-call IDs exactly equal the reported count.
- No execution exceeds any configured model/tool/wall-clock budget except an already-started parallel batch, which must be reported as bounded overshoot and blocked from further execution.

---

### Batch 2 — Versioned Role Contracts, Available Tools, and Typed Child Results

**Goal:** Make every role a real, testable contract rather than a label plus generic sentence.

**Files:**

- Create: `src/role-contracts.js`
- Create: `src/role-result-schemas.js`
- Create: `extensions/role-sidecar/index.ts`
- Modify: `src/multi-agent-topologies.js`
- Modify: `src/subagents.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Create: `tests/role-contracts.test.js`
- Create: `tests/role-sidecar.test.js`
- Modify: `tests/topology-policy-conformance.test.js`
- Modify: `tests/multi-agent-topologies.test.js`
- Modify: `tests/extension-import-boundary.test.js`

#### Tasks

- [ ] Move default role declarations out of the inline tuple list in `src/multi-agent-topologies.js` into validated `RoleContract` v2 definitions.
- [ ] Preserve `AgentRoleRegistry` as the canonical registry and integration-boundary adapter; do not route through compatibility-only `src/cognitive-architecture.js`.
- [ ] Replace unavailable pseudo-tools (`rg`, `diff`, `search`, `browser`, `test`, `lint`, `typecheck`, `benchmark`) with tools actually present in the child, or with narrow tools explicitly registered by `role-sidecar` such as `role_diff` and the approved verification runner.
- [ ] Launch children with `--no-extensions -e <absolute role-sidecar/index.ts>` and disabled skills/prompts by default. The sidecar must be a no-op outside `PI_ROLE_SIDECAR=1`.
- [ ] Register `submit_role_result` with the role-specific schema and `terminate: true`.
- [ ] Enforce child-side model/tool budgets and read-only path/tool policy in the sidecar, with parent enforcement as a fail-safe.
- [ ] Resolve requested tools against the actual registered child tool set before provider invocation; emit a clear degraded/error envelope for missing required capabilities.
- [ ] Make empty allowlists deny all. Give `worker` an explicit safe default rather than inheriting unrestricted built-ins accidentally.
- [ ] Add full role prompts containing objective, allowed actions, forbidden actions, evidence rules, output contract, budget reminder, and completion criteria.
- [ ] Add role model-policy overrides through role config/environment without hard-coding a provider. Record selected and fallback model IDs in provenance.
- [ ] Keep unknown custom roles read-only, bounded, normalized, and schema-valid. Reject ambiguous normalized role IDs.
- [ ] Validate node overrides as narrowing operations; require an explicit reviewed elevation marker for any broader policy.

#### Verification

```bash
node tests/role-contracts.test.js
node tests/role-sidecar.test.js
node tests/topology-policy-conformance.test.js
node tests/multi-agent-topologies.test.js
node tests/subagent-tool-source.test.js
node tests/extension-import-boundary.test.js
```

#### Stop condition

No role may launch with an unresolved required tool, ambiguous empty-policy semantics, missing output schema, or an unbounded custom prompt/result.

---

### Batch 3 — Real Workspace Isolation and Explicit Patch Transfer

**Goal:** Ensure mutating roles cannot alter the parent working tree, even when they time out, crash, are cancelled, or return invalid output.

**Files:**

- Create: `src/subagent-workspaces.js`
- Create: `src/subagent-patches.js`
- Modify: `src/subagents.js`
- Modify: `src/multi-agent-topologies.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `src/semantic-editor.js` or integrate through the existing Semantic Patch Workbench boundary
- Create: `tests/subagent-workspaces.test.js`
- Create: `tests/subagent-patch-transfer.test.js`
- Modify: `tests/subagents.test.js`
- Modify: `tests/multi-agent-topologies.test.js`
- Modify: `src/runtime-cleanup.js`
- Modify: `.pi/extensions/runtime-doctor/index.ts`

#### Workspace lifecycle

1. **Acquire:** Create a private workspace under `.pi/subagents/workspaces/<subagent-id>/`.
2. **Seed:** For Git repositories, create a detached worktree at the exact parent HEAD, apply staged/unstaged tracked changes as a binary patch, and copy bounded allowed untracked first-party files. Exclude ignored files, `.git`, `.pi`, credentials, sockets, devices, symlinks escaping the root, and over-limit payloads.
3. **Execute:** Spawn the mutating child with the workspace as `cwd`. Record parent revision/status fingerprint and workspace lease.
4. **Capture:** On every final state, capture a bounded binary patch, untracked-file manifest, changed-path hashes, and verification evidence.
5. **Validate:** Reject paths outside the repository, forbidden files, stale parent hashes, oversized patches, and overlapping/conflicting changes.
6. **Transfer:** Preview through Semantic Patch Workbench or an equivalent hash-checked packet. Parent application is explicit; topology success alone never applies it.
7. **Retain/clean:** Keep failed/timed-out workspaces for bounded recovery; clean successful no-change workspaces automatically only after result persistence. Runtime Cleanup handles age/size pruning with dry-run previews.

#### Tasks

- [ ] Add `handler-only`, `shared-readonly`, and `isolated-worktree` workspace policies.
- [ ] Refuse mutating roles outside Git until a separately tested non-Git copy sandbox exists. Never fall back silently to shared cwd.
- [ ] Ensure read-only roles have no mutating tools even in shared cwd.
- [ ] Prevent multiple mutable leases from targeting the same parent task unless their workspaces and merge order are explicit.
- [ ] Store workspace metadata and patch hashes, not file bodies, in `role-run` entries.
- [ ] Distinguish trajectory merge from filesystem patch transfer in APIs, docs, and UI.
- [ ] Add `/subagent-show` and Chat Focus links for retained recovery workspaces without making them writable through the parent session.
- [ ] Reproduce the observed failure: child makes successful writes, then times out; assert parent HEAD, status fingerprint, and file hashes are unchanged.
- [ ] Record implementation attempts in `timed-out-rpc-coder-mutates`; resolve only after the real mutation/timeout regression passes.

#### Verification

```bash
node tests/subagent-workspaces.test.js
node tests/subagent-patch-transfer.test.js
node tests/subagents.test.js
node tests/semantic-editor.test.js
node tests/multi-agent-topologies.test.js
node tests/runtime-cleanup.test.js
```

#### Exit gate

- Parent source hashes remain unchanged after successful, failed, cancelled, and timed-out mutating roles until explicit patch application.
- Patch preview/apply detects stale parent state and conflicts.
- No workspace path or patch escapes the project root.

---

### Batch 4 — Safe Router Modes, Global Topology Defaults, and Versioned Metrics

**Goal:** Replace keyword-only, background-duplicating role routing with deterministic intent classification and explicit execution semantics.

**Files:**

- Create: `src/role-router.js`
- Create: `src/role-topologies.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `src/multi-agent-topologies.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/topologies/*.json`
- Modify: `.pi/extensions/topology-catalog/index.ts`
- Modify: `src/skill-synthesis.js`
- Modify: `src/project-intelligence.js`
- Modify: `src/learning-loop.js`
- Create: `tests/role-router.test.js`
- Modify: `tests/auto-role-router-source.test.js`
- Modify: `tests/topology-extension-source.test.js`
- Modify: `tests/skill-synthesis.test.js`
- Modify: `tests/workflow-extensions-behavior.test.js`

#### Router modes

- `off`: classify nothing and inject nothing.
- `suggest`: show/persist a compact advisory; execute nothing.
- `shadow`: run only read-only contracts for evaluation while the normal parent turn continues; never return mutation or publish authority.
- `delegate`: explicit command/tool invocation only; the delegated topology owns the task, and the ordinary parent implementation turn does not run concurrently.

For compatibility, legacy `run` should warn and map to `shadow` until a user explicitly chooses `delegate`. It must never silently retain the current background mutating behavior.

#### Tasks

- [ ] Move classification into a pure tested module with explicit intents: `answer`, `research`, `plan`, `review`, `implement`, `verify`, `publish`, `destructive`, and `no-route`.
- [ ] Separate nouns from requested actions. Questions about an update must not become implementation. “Review and fix” must retain mutation intent. Security/token terms must not erase an explicit implementation request.
- [ ] Never automatically execute commit, push, publish, package install, release, credential, or destructive intents.
- [ ] Respect negation and explicit opt-out before all positive matches.
- [ ] Build a synthetic/redacted classifier corpus from the 45 audited suggestions, including the known misroutes and negative controls.
- [ ] Persist compact `auto-router.decision` entries for matched and skipped classifications: classifier version, intent, topology, reason code, confidence, prompt hash, mode, and outcome link—never prompt text.
- [ ] Register safe built-in topology definitions from extension/library code so trusted external repositories have defaults without copying `pi-harness/.pi/topologies`. Project configs may override only with explicit provenance and validation.
- [ ] Add per-node role contract version, budget, workspace policy, output schema, and mutation policy.
- [ ] Replace current generated/catalog/synthesized “all nodes are subagents” behavior with role-aware execution: handler-only roles stay handlers; read-only roles use shared-readonly; mutating roles require isolated-worktree.
- [ ] Update planner/coder/verifier, reviewer/verifier, docs, security, refactor, dependency, CI, performance, release, autonomous, and memory-curator recipes.
- [ ] Require valid typed upstream results on every `ok`/`no_errors` edge.
- [ ] Add topology run schema/runtime/contract versions. Exclude legacy packets from v2 success metrics and expose legacy/current counts separately.
- [ ] Ensure fallback topologies cannot turn a failed mutating run into a misleading successful read-only packet without preserving `fallbackOf`, previous errors, and incomplete mutation status.

#### Verification

```bash
node tests/role-router.test.js
node tests/auto-role-router-source.test.js
node tests/multi-agent-topologies.test.js
node tests/topology-policy-conformance.test.js
node tests/topology-extension-source.test.js
node tests/skill-synthesis.test.js
node tests/workflow-extensions-behavior.test.js
```

#### Router quality gate

- At least 90% precision on the reviewed synthetic corpus.
- 100% of explicit opt-outs and publish/destructive prompts produce no automatic execution.
- Zero question-only prompts route to mutating execution.
- Zero implementation prompts route to a topology incapable of implementing unless the result is explicitly advisory.

---

### Batch 5 — Migrate Skills, Fanout, Examples, and Product Surfaces

**Goal:** Ensure every caller uses registered contracts, bounded fanout, appropriate workspace policies, and typed result handling.

**Files:**

- Modify: `.pi/extensions/plan-fanout/index.ts`
- Modify: `skills/README.md`
- Review/modify all subagent-using skills, especially:
  - `skills/critique/SKILL.md`
  - `skills/cpp-review/SKILL.md`
  - `skills/audit/SKILL.md`
  - `skills/investigate/SKILL.md`
  - `skills/rootcause/SKILL.md`
  - `skills/refactor/SKILL.md`
  - `skills/cpp-cleanup/SKILL.md`
  - `skills/test-design/SKILL.md`
  - `skills/security/SKILL.md`
  - `skills/api-design/SKILL.md`
  - `skills/observability/SKILL.md`
  - `skills/subsystem-plan/SKILL.md`
  - `skills/research-framework-design/SKILL.md`
  - `skills/research-framework-loop/SKILL.md`
- Modify: `examples/multi-agent-topologies-example.js`
- Modify: `examples/topologies/planner-coder-verifier.json`
- Modify: `docs/productization-extensions.md`
- Modify: `docs/skill-synthesis.md`
- Create: `tests/role-consumer-contracts.test.js`
- Modify: `tests/productization-extensions.test.js`

#### Tasks

- [ ] Replace free-form cosmetic role labels with registered role IDs plus task-specific instructions. Use explicit custom read-only roles only when specialization cannot fit a registered contract.
- [ ] Make read-only analysis skills request `researcher` or `reviewer` contracts and require evidence/path/uncertainty outputs.
- [ ] Make mutating skills and plan fanout request `coder`/`refactorer` with `isolated-worktree`; never say that subagents edit the parent directly.
- [ ] Replace unbounded “10+ subagents” guidance with conflict-aware batches, default RPC concurrency 2, explicit per-worker budgets, and an evidence-based maximum. Large fanout proceeds in waves.
- [ ] Require exact file/task scopes and shared compact context packets so each child does not rediscover the whole repository.
- [ ] Require every fanout consumer to handle timeout, invalid output, partial patch, and cancellation as first-class outcomes rather than dropping missing workers.
- [ ] Make `plan_fanout` emit structured worker specifications: role ID, workspace policy, file zones, budget, merge policy, expected output schema, dependencies, and verification requirements.
- [ ] Remove references that conflate Agent/Explore labels with enforceable Pi role contracts.
- [ ] Update examples and docs to show explicit patch preview/apply, not implicit merge.
- [ ] Add a structural test that scans recipes, skills, catalog entries, and synthesized templates for unknown roles, unsafe mutating shared workspaces, missing budgets, and obsolete auto-run wording.

#### Verification

```bash
node tests/role-consumer-contracts.test.js
node tests/productization-extensions.test.js
node tests/skill-synthesis.test.js
node tests/subagent-tool-source.test.js
node tests/topology-extension-source.test.js
```

#### Stop condition

No shipped skill, recipe, generated topology, or example may request a mutable shared-cwd subagent, unknown cosmetic role, unbounded fanout, or success without typed result validation.

---

### Batch 6 — Session/Role Privacy, Retention, and Pi Fork Source Fix

**Goal:** Make private permissions the source default and safely remediate historical state without deleting it.

#### Part A — `Gattic/GatPi` source-backed fix

**Files in `~/pi`:**

- Modify: `packages/coding-agent/src/core/session-manager.ts`
- Modify/create tests under: `packages/coding-agent/test/session-manager/`
- Update fork documentation/changelog as required by that repository

Tasks:

- [ ] Create global and custom session directories with mode `0700`.
- [ ] Create/rewrite/fork session files with mode `0600`, including explicit `openSync`/`writeFileSync` modes and post-open hardening where platform semantics require it.
- [ ] Preserve permissions across migration, rewrite, fork, resume, import, and explicit `--session-dir` flows.
- [ ] Refuse symlink/type swaps when hardening an existing path.
- [ ] Add Linux permission tests with platform guards for systems that do not support POSIX modes.
- [ ] Submit the Pi fork change as its own verified commit; then update `config/pi-fork.env` `PI_FORK_PATCH_COMMIT` and `docs/pi-global-patches.md` in the harness.

Pi fork verification:

```bash
cd ~/pi
npm --prefix packages/coding-agent test -- test/session-manager/file-operations.test.ts
npm --prefix packages/coding-agent run build
npm --prefix packages/coding-agent test
```

#### Part B — Harness migration and role-state retention

**Files in `pi-harness`:**

- Modify: `src/session-hygiene.js`
- Modify: `scripts/session-hygiene.js`
- Modify: `.pi/extensions/runtime-doctor/index.ts`
- Modify: `src/runtime-cleanup.js`
- Modify: `tests/session-hygiene.test.js`
- Modify: `tests/runtime-cleanup.test.js`
- Modify: `config/pi-fork.env`
- Modify: `docs/pi-global-patches.md`
- Modify: `docs/runtime-configuration.md`

Tasks:

- [ ] Keep active-session hardening as a compatibility fallback until the minimum fork commit is ubiquitous.
- [ ] Add a one-time bounded permission migration plan for `~/.pi/agent/sessions`: dry-run first, active-file exclusion, path/type revalidation, then explicit apply.
- [ ] Never automatically archive or delete ordinary sessions. Temporary/one-shot archive selection remains opt-in and manifest-backed.
- [ ] Add private modes and size/age inventories for role records, results, child RPC sessions, retained workspaces, patches, and topology runs.
- [ ] Add cleanup previews for final role records/workspaces while preserving open/failed-debug evidence referenced by debug ledgers.
- [ ] Keep role-run session entries compact and transcript-free; add schema v2 field allowlist tests.

Harness verification:

```bash
node tests/session-hygiene.test.js
node tests/runtime-cleanup.test.js
scripts/session-hygiene.js --dry-run
scripts/setup-pi-fork.sh --check
scripts/check-pi-drift.sh
```

#### Exit gate

All newly created session/role state is `0600` inside `0700` directories, existing migration is previewable and explicit, and no active/debug-referenced evidence is removed.

---

### Batch 7 — Evaluation, Controlled Promotion, and Rollback

**Goal:** Prove that roles are useful, not merely policy-correct, before promoting broader delegation.

**Files:**

- Create: `scripts/benchmark-role-runtime.js`
- Create: `tests/fixtures/role-runtime/manifest.json`
- Create: `tests/role-runtime-benchmark.test.js`
- Create: `docs/role-runtime-benchmark.md`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `src/multi-agent-topologies.js`
- Modify: `docs/subagents.md`
- Modify: `docs/multi-agent-topologies.md`
- Modify: `docs/topology-cookbook.md`
- Modify: `README.md`

#### Benchmark cohorts

1. Deterministic fake-RPC protocol and failure fixtures.
2. Small read-only repository tasks with gold files/findings.
3. Small isolated mutation tasks with expected patches and tests.
4. Reviewer/verifier topology tasks with known defects and clean controls.
5. Router classification corpus derived from audited prompt classes.
6. A bounded opt-in real-project pilot after all deterministic gates pass.

#### Metrics

- valid completion rate by role and contract version
- false-success and false-failure rate
- timeout/cancellation rate
- queue, execution, and total p50/p95 latency
- actual model/tool calls versus budgets
- tool-policy violations and unavailable-tool launches
- parent-tree mutation before explicit patch application
- patch apply/conflict/verification outcomes
- typed output validity and evidence completeness
- router precision/recall by intent and mode
- human correction/rejection rate
- cost/tokens per accepted role result
- child/session/workspace disk growth and retention
- privacy/policy findings

#### Promotion bars

| Gate | Required bar |
|---|---|
| Execution truth | Zero false successes across all deterministic terminal/error fixtures |
| Budget enforcement | Zero unreported budget overruns; bounded parallel-batch overshoot only |
| Tool diagnostics | Exact call/result parity with explicit unmatched IDs |
| Policy | Zero forbidden tool calls; zero launches with unavailable required tools |
| Isolation | Parent source/status fingerprint unchanged before explicit apply in every final state |
| Typed outputs | 100% schema-valid results among `succeeded` runs |
| Read-only reliability | At least 90% valid completion; timeout rate at most 5% on the fixed small-task cohort |
| Mutation reliability | At least 90% expected-patch match and verification pass on the fixed isolated cohort |
| Router | At least 90% precision; 100% no-auto-execution for opt-out/publish/destructive cases |
| Latency | Read-only p95 below 120s and materially better than the 300s baseline; mutating p95 preregistered per fixture size |
| Privacy | All new files/dirs private; zero transcript/secret findings in compact provenance |
| Regression | Full harness and Pi fork suites pass; no TUI/RPC lifecycle regression |

#### Rollout stages

1. **R0 — Containment:** v1 remains available manually; auto mode `suggest`; v2 runs fixtures only.
2. **R1 — Read-only pilot:** v2 planner/researcher/reviewer available for explicit direct calls and shadow evaluation.
3. **R2 — Isolated mutation pilot:** coder/refactorer/verifier available only through explicit commands/tools in approved Git repositories.
4. **R3 — Explicit topology pilot:** planner/coder/verifier and reviewer/verifier run only on bounded opted-in projects.
5. **R4 — Suggest default:** v2 suggestions become the normal advisory surface after router gates pass.
6. **R5 — Optional delegation:** explicit `delegate` may be promoted; background mutating auto-run remains prohibited unless a separate experiment proves it safe and non-duplicative.

#### Rollback

Define and test before R1:

```text
PI_ROLE_RUNTIME_VERSION=1|2
PI_ROLE_MUTATION=off|isolated
PI_TOPOLOGY_AUTO_ROUTE=off|suggest|shadow|delegate
PI_ROLE_SIDECAR=0|1
```

Rollback must be immediate, must not require state migration, and must preserve v2 records/workspaces for diagnosis. Runtime Doctor should report selected version, compatibility mode, and any legacy/current state split.

#### Final verification

```bash
node tests/role-runtime-benchmark.test.js
node scripts/benchmark-role-runtime.js --fixture-only
bash scripts/check-subagent-tui.sh
bash scripts/check-topology-tui.sh
PI_CHECK_TUI=1 bash scripts/check-all.sh
scripts/setup-pi-fork.sh --check
scripts/check-pi-drift.sh
```

---

## 5. Sequencing, Hotspots, and Parallel Work

### Critical dependency chain

```text
Contain unsafe auto-run
  -> truthful terminal status + exact counters + budgets
  -> versioned role contracts + typed submit tool
  -> isolated workspaces + explicit patch transfer
  -> router/topology redesign
  -> skill/catalog migration
  -> privacy migration
  -> measured rollout
```

Do not implement router promotion, mutating topology changes, or skill fanout migration before execution truth and workspace isolation exist.

### Hotspot files

- `src/subagents.js` — process lifecycle, budget, result, workspace, persistence
- `src/multi-agent-topologies.js` — role registry, policy, node truth, aggregation
- `.pi/extensions/reasoning-runtime/index.ts` — commands/tools/router/session provenance
- `src/integration-boundary.js` — public adapter contract and persistent topology runs
- `.pi/extensions/topology-catalog/index.ts` and `src/skill-synthesis.js` — generated executable recipes
- `src/session-hygiene.js` and `~/pi/.../session-manager.ts` — privacy migration/source defaults

Changes touching the same hotspot should be sequential and checkpointed. Use structural refactors only after focused tests lock current behavior.

### Safe parallel work

After Batch 2 contracts stabilize:

- role prompt/schema authoring by distinct role file
- synthetic router fixture authoring
- documentation updates in non-overlapping files
- Pi fork permission tests versus harness role benchmark fixture work
- migration of independent read-only skills after the consumer contract test exists

### Work not to parallelize

- `src/subagents.js` lifecycle and workspace integration
- `AgentRoleRegistry` contract migration and topology node override rules
- router mode semantics and input-hook behavior
- topology run schema migration and metrics filtering
- session permission application and archive logic

---

## 6. Definition of Done

Pi Roles v2 is complete only when all of the following are true:

- [ ] The four open debug threads are resolved with regression evidence, not merely code changes.
- [ ] Every shipped role has a validated v2 contract, real tools, explicit workspace/mutation policy, enforced budgets, and typed output schema.
- [ ] A role cannot report success after provider error, output limit, cancellation, timeout, empty output, invalid schema, or budget breach.
- [ ] Tool/model counters exactly match child events and call IDs.
- [ ] Mutating roles never change the parent tree before explicit patch application.
- [ ] Failed/timed-out mutation work remains recoverable in a private bounded workspace.
- [ ] Auto routing distinguishes suggestion, read-only shadow, and explicit delegation; it never background-executes mutating work alongside the parent.
- [ ] Built-in topologies are available consistently across trusted repositories, with project override provenance.
- [ ] Historical synthetic runs are visible but excluded from v2 reliability claims.
- [ ] All subagent-using skills, catalog recipes, synthesized topologies, examples, and plan fanout conform to the v2 consumer contract.
- [ ] New global Pi session files and directories are private at creation, and historical permission migration is available as an explicit dry-run/apply workflow.
- [ ] Fixture and pilot gates meet the promotion bars; full harness, TUI/RPC, and Pi fork checks pass.
- [ ] Runtime Doctor documents current version, mode, contract health, legacy state, budgets, workspace policy, and rollback commands.
- [ ] Documentation consistently calls the mechanism delegation/sidecars and accurately distinguishes context, trajectory, session, and filesystem isolation.

---

## 7. Recommended First Execution

Start with **Batch 0 and Batch 1 only**:

1. Contain mutating automatic `run` behavior while keeping `suggest` stable.
2. Add the bounded audit script and synthetic evidence fixtures.
3. Fix terminal-status truth, exact diagnostics, and budget enforcement.
4. Run focused tests and record outcomes in the three matching debug threads.
5. Review the Batch 1 diff and evidence before designing the sidecar schema implementation details for Batch 2.

Do not begin mutating role/topology/skill migration until Batch 3 demonstrates that a timed-out child can write freely inside its workspace while the parent tree remains unchanged.
