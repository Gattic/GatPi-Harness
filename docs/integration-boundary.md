# Pi core integration boundary for cognitive subsystems

Target shape:

```text
Pi core
  -> integration adapter
  -> library public API
```

Pi core must not import implementation internals from tracing, context, anchoring, memory, verification, entropy, orchestration, or branching modules directly. Core code should construct adapters from `src/integration-boundary.js` and interact only with those adapter methods.

## Shared adapter contracts

All adapters accept these dependency types:

- `enabled: boolean` — disables the subsystem without constructing Pi-specific conditionals in core call sites.
- `storage` — injectable persistence interface. The in-memory reference implementation is `MemoryJsonStorage`.
- `sink` — injectable logging/tracing sink. The null and test implementations are `NullSink` and `RecordingSink`.

Storage interface:

```js
readJson(key, fallback)
writeJson(key, value)
appendJsonl(key, value)
readJsonl(key)
```

Sink interface:

```js
emit(event)
info(message, data)
warn(message, data)
error(message, data)
```

Disabled adapters return explicit `{ enabled: false, skipped: true }`-style results and do not mutate storage or sink state.

## Public APIs by library

### Tracing

Current implementation: project-local extension `.pi/extensions/trace-observability/index.ts` contains its own event bus, storage, commands, replay, and instrumentation.

Boundary API: `TraceAdapter`.

```js
emit(event)
span(baseEvent, fn)
recent(limit)
export()
```

Persistence/logging must flow through injected storage/sink. Pi core should emit normalized lifecycle/tool/model/session events to `TraceAdapter`; it should not write JSONL directly.

### Context layering

Library: `src/layered-context.js`.

Public API:

```js
new LayeredContextMemory(options)
upsert(block)
remove(id, reason)
pack({ tokenBudget, query, dependencyFocus, includeScratch })
compactLayer(layerId, options)
metrics(query)
```

Boundary API: `LayeredContextAdapter`.

```js
upsert(block)
pack(request)
compactLayer(layer, options)
metrics(query)
persist()
```

### File anchoring / semantic editing

Library: `src/semantic-editor.js`.

Public API:

```js
SemanticAnchor.fromRegion(args)
anchor.resolve(content, options)
new SemanticPatch(input)
new SemanticEditEngine(options)
engine.apply(patches)
engine.rollback(id)
engine.metrics()
parseStructuralNodes(content, filePath)
semanticDiff(before, after, filePath)
validateBalancedSyntax(content, language)
sha256(value)
```

Boundary API: `FileAnchoringAdapter`.

```js
createAnchor(args)
createPatch(args)
validate(content, patches)
diff(before, after, filePath)
apply(content, patches, options)
rollback(content, checkpoint)
metrics()
```

Pi core should pass file contents through this adapter. The library should not read or write Pi session state.

### Cognitive memory

Library: `src/cognitive-memory.js`.

Public API:

```js
new CognitiveMemory(options)
remember(entry)
retrieve(query, options)
link(fromId, toId, relation)
consolidate(options)
forget(options)
lineage(id)
metrics()
save(file)              // legacy file helper, not for Pi core
CognitiveMemory.load(file, options) // legacy file helper, not for Pi core
```

Boundary API: `CognitiveMemoryAdapter`.

```js
remember(entry)
retrieve(query, options)
consolidate(options)
metrics()
persist()
```

Pi core persistence must use adapter storage, not `save()` / `load()` directly. Routine verifier evidence, file-change anchors, and assistant episodes are excluded from default hot recall; exact normalized duplicate content is rejected before insertion.

### Canonical project memory and state governance

Libraries:

- `src/project-memory-schema.js`
- `src/project-memory-store.js`
- `src/project-memory-decisions.js`
- `src/project-memory-index.js`
- `src/project-memory-recall.js`
- `src/memory-content-scanner.js`
- `src/session-search.js`
- `src/memory-state-catalog.js`
- `src/state-inventory.js`
- `src/state-retention.js`

Boundary APIs:

```js
boundary.projectMemory.status()
boundary.projectMemory.save(candidate, options)
boundary.projectMemory.consider(candidate, options)
boundary.projectMemory.recall(query, { cacheOnly, limit, kinds })
boundary.projectMemory.compile({ apply })
boundary.projectMemory.format(result, options)
boundary.projectMemory.standing(options)
boundary.projectMemory.formatStanding(result, options)
boundary.projectMemory.setStanding({ entryId, standing }, { apply, explicit })
boundary.projectMemory.correction(input, options)
boundary.memorySafety.scan(value, options)
boundary.memorySafety.assert(value, options)
boundary.memorySafety.redact(value, options)
boundary.sessionSearch.search(query, options)
boundary.sessionSearch.get(anchorId, options)
boundary.memoryState.map(options)
boundary.memoryState.search(query, options)
boundary.memoryState.lineage(id)
boundary.retention.preview(options)
boundary.retention.apply(options)
boundary.statePermissions.preview(options)
```

Obsidian notes under `Memory/Projects/<repo>-<root-hash>/` are canonical. Compiled cache and cognitive state are rebuildable. Hermes output is advisory. Extensions must consume these services through `src/integration-boundary.js`, not import store/index internals. Task-conditioned prompt recall reads validated canonical vault notes directly and inspects current Git state; it does not call a provider or require a compiled cache. Explicit `cacheOnly` callers instead use a private compiled projection with matching project, cache-schema and source-decision identity. These are distinct paths: cache-only behavior must not be used to describe the default prompt path. See [project-memory operations](project-memory-operations.md#recall-behavior) for recall eligibility and exclusions.

The shared safety adapter owns durable-memory secret/transcript/path/size, stored-instruction, Unicode-control, exfiltration, embedded-data, and encoded/high-entropy checks. Session search is explicit, project-scoped, bounded, redacted, direct-read only, and returns opaque anchors. Standing instructions remain flags/projections of verified canonical entries; corrections remain reviewed candidates. None creates a second memory authority or a persistent session index.

### Maintenance preview and unified provenance

Libraries:

- `src/memory-maintenance.js`
- `src/provenance-graph.js`

Boundary APIs:

```js
boundary.memoryMaintenance.preview({ write, maxCandidates, maxElapsedMs })
boundary.memoryMaintenance.due(intervalHours)
boundary.memoryMaintenance.status()
boundary.provenance.build({ seedIds, depth, maxNodes, maxEdges, maxElapsedMs })
boundary.provenance.lineage(seedId, options)
boundary.provenance.export(input, { explicit: true, fileName })
boundary.provenance.status()
```

Maintenance is report-only. Its adapter composes typed-memory curation, project-memory decisions, Evidence Binder metadata, retention preview, managed-permission preview, and cache/source-decision consistency without invoking any apply path. Provenance provider methods return bounded normalized metadata rather than source records. The graph preserves source ownership and exact-version hashes through typed nodes/edges; it is not another memory authority. Export is root-confined, private, and rejected unless the caller carries an explicit current-user export request.

Both adapters exclude prompts, transcripts, private reasoning, command arguments, raw tool output, source bodies, secrets, and absolute paths. Provider unavailability, bounds, and elapsed-time truncation are explicit coverage facts. Disabling either adapter does not change project-memory rollout or erase existing state.

### Compounding effectiveness

Library: `src/compounding-effectiveness.js`.

Boundary API:

```js
boundary.compounding.generate({ write, cohortId, gateEvidence })
boundary.compounding.status()
boundary.skills.compoundingRecords({ limit })
boundary.learning.compoundingRecords({ limit })
boundary.executionOutcomes.compoundingRecords({ limit })
boundary.memoryMaintenance.history({ limit })
```

The adapter joins only bounded normalized metadata. Exact-version deltas require explicit control/candidate cohort IDs and session hashes; absent or mismatched identity returns `insufficient-data`. Private scorecard writes do not mutate any source store or authorize a rollout. `FileIntegrationStorage` is re-exported only so project extensions can construct file-backed adapters without importing storage internals directly.

### Goal control and completion evidence

Libraries:

- `src/goal-controller-actions.js`
- `src/evidence-binder.js`

Boundary APIs:

```js
boundary.goalController.parseDecision(value, options)
boundary.goalController.validateDecisionV3(value)
boundary.goalController.validateAction(value)
boundary.goalController.dispatch(action, goalState)
boundary.goalController.authority(topologyId, goalState)
boundary.goalEvidence.validateCompletion({ evidenceIds, goalCreatedAt, expectedFingerprints })
```

Goal extensions import these adapters from `src/integration-boundary.js`; they do not import controller-action or evidence-store internals. The controller adapter enforces exact schema-v3 actions, requires Hermes-authored executable prompts, and checks topology authority before passing the prompt through verbatim. The evidence adapter returns only ID/timestamp/fingerprint/pass metadata after registration, freshness, fingerprint, and `ok=true` checks; evidence bodies never cross this surface.

### Verification

Library: `src/verification-pipeline.js`.

Public API:

```js
new Verifier(spec)
new VerifiedExecutionPipeline({ verifiers, policies, cache, evidenceStore, metrics, feedbackSinks })
pipeline.execute(request)
pipeline.verify(request)
analyzeImpact(changeSet)
defaultPolicies()
```

Boundary APIs: `VerificationAdapter` and `VisualVerificationAdapter`.

```js
boundary.verification.captureChangeSet({ cwd, files })
boundary.verification.captureTreeFingerprint(cwd)
boundary.verification.compareTreeFingerprint(cwd, evidence)
boundary.verification.verify(request)
boundary.verification.execute(request)
boundary.verification.metrics()
boundary.visualVerification.readiness(request)
boundary.visualVerification.plan(request)
boundary.visualVerification.run(request)
boundary.visualVerification.resolveArtifact(artifactRef)
```

The library already supports injectable cache, evidence store, metrics, and feedback sinks. The boundary supplies in-memory reference implementations so verification can run without filesystem writes. Working-tree capture returns a versioned content-addressed change set: file bodies are hashed incrementally and analyzed one pair at a time, while only bounded impact samples and fixed-size digests cross the boundary. Oversized or binary source files retain exact content identity but produce typed incomplete-analysis findings that verification rejects rather than silently omitting policy checks. Shared-tree freshness uses a streaming Git-status worker so large porcelain output is never buffered in the parent process. Visual operations are configured-case-only, persist metadata rather than captured bodies, and expose no baseline mutation API. Explicit `requiredProviders: ["visual"]` uses the shared provider-readiness gate.

### Unified evidence and rollout

Library: `src/rollout-center.js`.

Boundary API: `RolloutCenterAdapter`.

```js
boundary.rolloutCenter.snapshot(options)
boundary.rolloutCenter.capability(capabilityId)
boundary.rolloutCenter.provenance(provenanceRef)
boundary.rolloutCenter.status()
```

The adapter composes bounded public projections from existing authorities. It creates no cache or rollout history and has no launch, record, apply, promote, or stage-advance operation. Project extensions must access rollout aggregation through this boundary rather than importing scorecard/ledger internals.

### Entropy monitoring

Library: `src/entropy-monitor.js`.

Public API:

```js
new EntropyMonitor(options)
monitor.observe(event)
monitor.health()
monitor.dashboards(file)
monitor.persistLongTerm()
```

Boundary API: `EntropyAdapter`.

```js
observe(event)
health()
dashboards(file)
```

Use `EntropyPersistenceAdapter` for injected persistence. Pi core should emit normalized events; entropy logic must not inspect Pi internals directly.

### Reasoning runtime

Library: `src/reasoning-runtime.js`.

Public API:

```js
new ReasoningRuntime({ storage, sink })
createPlan(input)
decomposeTask(input)
trackHypothesis(input)
recordDecision(input)
recordExecutorAction(input)
recordVerifierEvidence(input)
addVerifierFeedback(input)
updateMemory(input)
createCheckpoint(input)
compareBranches(input)
analyzeFailure(input)
publicArtifacts(options)
resultPacket()
```

Boundary API: `ReasoningRuntimeAdapter`.

```js
createPlan(input)
decomposeTask(input)
trackHypothesis(input)
recordDecision(input)
recordExecutorAction(input)
recordVerifierEvidence(input)
addVerifierFeedback(input)
updateMemory(input)
createCheckpoint(input)
compareBranches(input)
analyzeFailure(input)
artifacts(options)
packet()
persist()
```

Compatibility API: `OrchestrationAdapter.coordinate(task, options)` still exists for older extension code, but it now creates scaffold artifacts only. It does not run hard-coded planner/executor/verifier cognition.

### Branching

Library: `src/session-branches.js`.

Public API:

```js
new SessionBranchManager({ cwd, store, scorer, mergeEngine, policies, ignore })
createSnapshot(state)
createBranch(request)
checkpoint(branchId, state)
rollback(branchId, snapshotId, options)
merge(left, right, options)
autoBranch(event, states)
visualizeTree()
```

Boundary API: `BranchingAdapter`.

```js
createSnapshot(state)
createBranch(request)
autoBranch(event, states)
list()
visualizeTree()
```

The branch store is injectable. Pi core should not depend on `.pi/session-branches` paths.

### Subagent lifecycle

Libraries:

- `src/subagents.js`
- `src/subagent-lifecycle.js`
- `src/role-contracts.js`

Boundary API: `SubagentAdapter` as `boundary.subagents`.

```js
preflight(request, options)
createSubagent(request)
launchSubagent({ subagentId, context, mergePolicy })
runSubagent({ subagentId, context, mergePolicy })
waitSubagent({ subagentId, timeoutMs })
steerSubagent({ subagentId, message })
interruptSubagent({ subagentId, reasonCode })
cancelSubagent({ subagentId, reason })
continueSubagent({ subagentId, task })
resumeSubagent({ subagentId, task })
getSubagent({ subagentId })
listSubagents({ parentSessionId })
status({ parentSessionId })
events(options)
subscribe(listener)
```

Preflight and public DTO/event projections are versioned and content-bounded. Live execution has one detached RPC sidecar path. Settled attempts are immutable, continuation creates linked attempts, process close precedes receipt/cleanup, child capability is an intersection, and nested delegation is disabled. Fleet/status APIs expose hierarchy, revisions, hashes, profile/accounting, terminal codes, receipts, and recovery state without task text, prompts, transcripts, commands/tool payloads, or paths.

Role discovery/refinement is owned by `MultiAgentTopologyAdapter`: `discoverRoles()`, `refineRole()`, `roleRefinementHistory()`, and `rollbackRoleRefinement()`. Refinements require explicit reviewed approval and may only narrow tools, budgets, and task scope. Policy elevation is removed; isolated patch review uses the dedicated `patch-reviewer` role.

### Governed skill intake

Library: `src/skill-intake.js`.

Boundary API: `SkillIntakeAdapter` as `boundary.skillIntake`.

```js
validateSource(sourceId)
deterministicChecks(sourceId)
handlerRegistry()
listCandidates(options)
inspectCandidate(candidateId)
importCandidate(candidateId)
status()
```

The adapter is the only extension-facing intake API. It confines sources and private candidates below the configured project-local `.pi/skill-intake/` root, validates immutable manifest/hashes before model execution, and injects deterministic handlers into the topology engine by allowlisted `handlerId`. Candidate import delegates to `boundary.skills` but preserves untrusted candidate state and grants no approval. There is deliberately no publish, push, clone, fetch, install, discovery, or memory API.

### TypeSafe System One

Libraries: `src/typesafe-client.js` (HTTP), `src/typesafe-turn-judgment.js` (request and decisions), `src/typesafe-evaluation.js` (records and metrics).

Boundary API: `SystemOneAdapter` as `boundary.typesafe`.

```js
active()
startTurn({ text, source })           // one request per turn; Promise never rejects
turnFor(text) / currentTurn()          // pending result for the same prompt, or null
service()                              // frozen { modes, turnFor, currentTurn } for other extensions
recordTurn({ sessionKind, judgment, local })
turnRecords() / pruneTurnRecords({ keep })
readiness()                            // modes, keyPresent (boolean), pinned model, outcome counts
probe()                                // live models + synthetic one-question check
```

Disabled or mode `off` means no request and `{ enabled: false, skipped: true }` from `recordTurn`. Results resolve to `{ ok: true, model, inputTokens, latencyMs, decision }` or `{ ok: false, reason }` with a fixed reason code; consumers treat failure as absence. With `persist: true`, field records go to the shared `turnRecordDir(env)` (`<PI_CODING_AGENT_DIR or ~/.pi/agent>/typesafe/`) whichever project Pi was launched in; otherwise they stay in memory.

## Coupling analysis

Current direct Pi-core calls: none in this repository. The existing integrations are project-local extensions:

- `.pi/extensions/trace-observability/index.ts` directly implements tracing and Pi hooks.
- `.pi/extensions/reasoning-runtime/index.ts` consumes cognitive, memory, topology, and subagent services through `src/integration-boundary.js`; its remaining direct imports are Pi UI/runtime helpers rather than competing cognitive authorities.

Coupling issues found:

1. Some libraries provide convenience filesystem persistence (`CognitiveMemory.save/load`, `EvidenceStore`, `VerificationCache`, `VerificationMetrics`, `MetricsPersistence`, `SnapshotStore`). These are useful standalone helpers but should not be called directly by Pi core.
2. Trace observability is extension-shaped rather than library-shaped. The boundary introduces `TraceAdapter` as the core-facing contract; future work can move extension internals behind that adapter.
3. Branching snapshots read the filesystem by design. The side effect is explicit through `SessionBranchManager.createSnapshot()` and must be invoked only by `BranchingAdapter`.
4. Verification may execute commands through configured verifiers. That remains an explicit verifier dependency, not hidden global behavior.
5. No library should own Pi context/session objects. Adapters accept plain events, text, blocks, patch sets, and change sets.

## Integration rules

- Pi core imports `createPiIntegrationBoundary()` or individual adapter classes only.
- Adapters translate Pi events into library-neutral input objects.
- Libraries must not import Pi packages.
- Libraries must not mutate process-global state. Any mutable state must be instance-local.
- Persistence must use injected storage in Pi-integrated mode.
- Logging/tracing must use injected sinks in Pi-integrated mode.
- Configuration must be able to disable each subsystem independently.
- Tests for libraries and adapters must run without Pi, without extensions, and without persistent filesystem state except temporary directories explicitly owned by tests.

## Core vs extension placement decision

Recommended ownership:

- **Core-ready boundary**: `src/integration-boundary.js` is a thin composition root; adapter implementations live in per-subsystem modules under `src/integration-boundary/` (`common`, `memory`, `verification`, `context`, `agents`, `governance`). Adapter contracts, injected storage/sink interfaces, and stable event/input schemas remain core-ready.
- **Extension import policy**: `src/extension-import-policy.js` is the single source of truth for extension-visible `src/` surfaces and forbidden subsystem internals.
- **Extension-owned UI/hook mapping**: slash commands, TUI widgets, Pi lifecycle event mapping, command rendering, live trace views, and policy choices about when to inject or verify.
- **Experimental for now**: automatic cognitive orchestration, automatic risky-operation branching, and broad prompt injection. These remain opt-in extension behavior until UX and safety are validated interactively. The cognitive extension now follows `PI_COGNITIVE_ORCHESTRATION_ENABLED=1` instead of forcing orchestration on.
- **Trace migration path**: reusable trace runtime belongs in `src/trace-observability.js`; project-local extension code should become a Pi hook/command adapter over that library.

## Implementation status

Implemented in:

```text
src/integration-boundary.js                 # composition root and public exports
src/integration-boundary/common.js          # storage, sinks, clone, safe(), result limits
src/integration-boundary/memory.js          # memory, context, anchoring, state adapters
src/integration-boundary/verification.js    # verification cache/evidence/metrics
src/integration-boundary/context.js         # entropy, reasoning, orchestration, branching
src/integration-boundary/agents.js          # subagents, topologies, skills, tasks
src/integration-boundary/governance.js      # goals, outcomes, typesafe, trace
src/integration-config.js
src/file-integration-storage.js
src/trace-observability.js
src/extension-import-policy.js
tests/integration-boundary.test.js
```

Reference in-memory dependencies:

```text
MemoryJsonStorage
NullSink
RecordingSink
MemoryVerificationCache
MemoryEvidenceStore
MemoryVerificationMetrics
EntropyPersistenceAdapter
MemoryBranchStore
```

The adapter tests prove each subsystem can be used independently and disabled cleanly.

## Trace extraction status

Reusable tracing now lives in:

```text
src/trace-observability.js
```

It owns the core trace runtime pieces:

- normalized event schema
- `TraceRuntime`
- `FileTraceStorage` with rotation and payload compression
- `TraceMetrics`
- `FailureAnalyzer`
- `ReplayIndex`
- export/replay/status helpers

The project-local trace extension is now a Pi hook/command adapter over this runtime.

## Direct import migration rule

Pi core and extensions may import only boundary/public adapter surfaces. The enforced allowlist and forbidden-internal list live in a single source of truth:

```text
src/extension-import-policy.js
```

That policy is enforced across every extension root by `tests/extension-import-boundary.test.js`:

```text
.pi/extensions
extensions
src/pi-core-adapters
```

Do not duplicate the allowlist in docs, scripts, or tests. Add a new public surface to `EXTENSION_IMPORT_ALLOWLIST` and cover it with a test instead. Extensions must not import subsystem internals such as `src/cognitive-memory.js` or `src/verification-pipeline.js` directly.

## Workflow outcome and docs-routing boundary

Outcome schema v2 distinguishes `succeeded`, `domain-negative`, `blocked`, `not-applicable`, `cancelled`, `timed-out`, `infrastructure-failed`, and `unknown`. Failed repository builds/tests, findings, dirty readiness, and missing proof are domain negatives; policy/safety rejections are blocked; bounded watch expiry is timed out; only adapter/contract/runtime faults are infrastructure failures. Test Runner empty inference/rerun and Evidence Binder without Verification Center evidence remain actionable `not-applicable`. Learning and session-mining consumers generate generic reliability candidates only from infrastructure failures and timeouts.

The shared extension wrapper records terminal model-tool lifecycle metadata alongside command, prompt-suggestion, context-injection, router, recommendation, opportunity, and feature-signal telemetry. Schema-v6 records contain only extension/tool/feature identifiers, exact source fingerprints, fixed operation/action/reason categories, canonical outcome, coarse session kind, duration, and bounded numeric counters. Version/source cohorts and operation canaries preserve the same metadata-only boundary. Interactive command/tool records carry a local-salt HMAC session token so the current session can be excluded exactly and adoption can use a privacy-safe unique-session denominator. Records never contain call IDs, raw session IDs, target IDs, arguments, paths, prompts, summaries, evidence, raw output, or errors. Reports expose token coverage, eligible denominators, unknown outcomes, and feature-level size/duration savings. General legacy telemetry is not reinterpreted; the only continuity reader remains prompt-policy-specific and accepts only schema-v1 `prompt-suggestion` rows whose fixed source/action/outcome fields are already canonical.

`docs_lookup` remains confined to the active repository and its installed packages. Pi framework documentation outside cwd crosses the boundary only through an explicit `read` of the configured Pi source checkout (`$PI_SOURCE_ROOT/packages/coding-agent/`, with sibling `../pi` as the default layout). The docs adapter must not relax cwd policy to make external framework docs searchable.

## CodeGraph adapter boundary

Reusable CodeGraph integration lives in `src/codegraph-adapter.js`, while `.pi/extensions/codegraph/index.ts` only registers Pi commands/tools and lifecycle hooks. The library shells out to the local `codegraph` CLI with argument arrays, records freshness state under `.pi/codegraph/`, provides doctor diagnostics, and exposes advisory helpers such as affected-test lookup for Project Intelligence, Test Gap Planner, Verification Center, Code Context, and Runtime Doctor. CodeGraph output is local-first advisory context; it is not a reasoning runtime, does not store private scratchpads, and remains optional/non-blocking unless a Verification Center call explicitly includes it in `input.requiredProviders`.

## Semgrep adapter boundary

Reusable Semgrep integration lives in `src/semgrep-adapter.js`, while `.pi/extensions/semgrep/index.ts` only registers Pi commands/tools. The library shells out with argument arrays, disables metrics by default, reports binary/config/scan readiness separately, and runs a bounded config validation before scans. `p/default` is the reproducible default; `auto` is rejected while metrics are off, and config success/failure have separate cache TTLs. `semgrepCodegraphAdvisory` preserves CodeGraph affected-test guidance when Semgrep is degraded. Missing binaries, unavailable packs, Docker permission issues, or CodeGraph absence remain degraded advisory state; they become mandatory proof gates only when a Verification Center call explicitly names them in `input.requiredProviders`. The shared contract is `src/provider-readiness.js`.

## Obsidian adapter boundary

Reusable Obsidian integration lives in `src/obsidian-adapter.js`, while `.pi/extensions/obsidian/index.ts` registers Pi commands/tools and injects lightweight model awareness. Readiness is layered across vault filesystem, desktop executable/open state, Hermes executable, authentication, provider/model, local Markdown operations, and curation; desktop absence does not disable filesystem-backed features. Automatic awareness performs only a local, non-authenticated status probe. Active authentication and curation probes are explicit and bounded; curation smoke is dry-run and writes no note. Persisted events retain only operation/outcome/category/duration/count metadata—never credentials, prompts, raw provider output, vault contents, source bodies, or paths.

## Progressive code-context retrieval boundary

The project-local `.pi/extensions/code-context/index.ts` extension imports only `src/code-context-service.js`. The extension owns Pi registration and session shutdown; the CommonJS service owns path policy, provider routing, ranking, token packing, freshness/degradation semantics, and compact rendering.

```text
Pi extension (`code_context`)
  -> src/code-context-service.js
  -> lexical/LSP/CodeGraph/project/build providers
  -> provider-neutral retrieval contracts
```

Source retrieval state is not cognitive memory. Source cards, ranges, content hashes, and visibility references stay under the code-context service/runtime state and are never promoted through `LayeredContextAdapter` merely because source was retrieved. Provider-specific `lsp`, `codegraph_*`, and `semgrep_*` extensions remain diagnostics/admin surfaces; new agent-facing retrieval operations extend `code_context` rather than introducing duplicate generic tools.

Stale or degraded provider results are advisory. They cannot suppress baseline tests, claim compiler resolution, authorize mutation, or become gating-safe. The initial rollout performs no automatic prompt injection.

`src/code-context-telemetry.js` emits bounded classification/provider/ranking/packing/expansion/impact evidence through the extension's namespaced `code-context:retrieval` event. The trace-observability extension subscribes once per active session, retains stable session/project IDs instead of the Pi context object, and unsubscribes on shutdown/reload. It reuses `src/trace-observability.js`; no second trace runtime or source archive is introduced. Learning outcomes attribute retrieval effects through explicit strategy/query/run IDs, with keyword dimensions used only as a legacy fallback when those IDs are absent.

## Filesystem-backed adapter storage

`FileIntegrationStorage` implements the storage interface for production-like usage:

```js
const { FileIntegrationStorage } = require("./file-integration-storage");
const storage = new FileIntegrationStorage(".pi/cognitive-automation");
```

The reasoning runtime extension currently uses the legacy `.pi/extensions/reasoning-runtime/` path and wires storage under `.pi/cognitive-automation/`, so adapter memory/context/reasoning state survives extension reloads without direct library file helpers.

## Context-injection and prompt-suggestion boundary

The first interactive reasoning injection contains the complete public scaffold and runtime version. Later injections contain only changed objective, decisions/evidence, constraints/safety, or warnings/routing sections. Historical objectives, successful proof history, exact duplicate memory, and stable router classifications cannot repeatedly cross the boundary. `context-injection` telemetry is metadata-only: rendered/injected/saved character counts, categorical reason, and changed boolean.

Prompt suggestions wait for Pi's post-retry `agent_settled` boundary and keep the original deterministic local selector ahead of optional provider work. The provider packet restores the original eight-message recent-context semantics without restoring raw transcript export: text-only public message content is capped per message and in aggregate, redacted and scanned through the prompt-suggestion safety surface, and then represented as a single bounded string. The packet never contains raw session objects, unredacted tool output, private reasoning, secrets, command arguments, or absolute paths. Model refinement is not an unconditional hot-path call in evidence-gated `auto` mode: `src/prompt-suggestion-policy.js` evaluates only metadata events against sample/value/reliability bars. An incomplete non-timeout cohort may schedule one abortable background bootstrap attempt per new idle state without a cooldown; passing the acceptance and non-timeout failure bars is still required for unrestricted automatic refinement. Historical/upstream timeouts are observable but excluded from those gates. The configured machine-wide model is resolved through Pi's provider-neutral model registry, independent of the session model, and the extension does not invoke Hermes. Explicit cancellation and all privacy/authentication checks remain in force. Generated/refined/skipped and user-action telemetry contains source, action, outcome, and latency only; suggestion text, session excerpts, prompts, and outputs never cross into telemetry.

## Branch recovery and export boundary

Branch recovery snapshots are private local checkpoints, not durable memory. `src/session-branches.js` sanitizes private filesystem paths and transcript/prompt/raw state for both `SnapshotStore` and the integration boundary's storage-backed store, enforces a bounded serialized size, and writes private state. Metadata-only export packets contain lineage, checkpoint IDs, scores, verifier aggregates, file counts/bytes, and fingerprints—never source bodies, memory/context/tool state, prompts, messages, or transcripts.

Snapshot cleanup is preview-first and revalidates inode/content identity before mutation. Reachability includes live branches and their ancestor lineage, so retention never deletes a required rollback checkpoint. Privacy Guard scans recovery-state fields structurally and treats private snapshot paths as actionable without misclassifying embedded ordinary source recovery as a transcript.
