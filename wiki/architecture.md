# Architecture and subsystems

These are the reusable local libraries behind the harness extensions. Each subsystem is independently testable and is consumed through the adapter boundary in `src/integration-boundary.js` rather than by direct internal imports. The main README summarizes what they buy you; this page keeps the implementation-level detail.

## Cognitive memory substrate

A true four-system cognitive memory substrate is available at:

```text
src/cognitive-memory.js
```

It implements independent episodic, semantic, procedural, and strategic memory systems with separate retrieval, decay, compaction, relevance ranking, consolidation, contradiction handling, cross-memory linking, intelligent forgetting, provenance/verification tracking, persistence, metrics, and retrieval/consolidation observability.

Docs, tests, and example:

```bash
node tests/cognitive-memory.test.js
node examples/cognitive-memory-example.js
```

See `docs/cognitive-memory-architecture.md` for the architecture and API.

## Semantic layered context architecture

A structured cognitive context engine is available at:

```text
src/layered-context.js
```

It implements L0-L4 memory layers with independent TTL/retention policies, semantic decay, budget-aware context packing, protected architecture memory, compaction, integrity checks, metrics, and inclusion/removal observability.

Docs and runnable example:

```text
docs/layered-context-architecture.md
examples/layered-context-example.js
```

Run checks:

```bash
node tests/cognitive-memory.test.js
node tests/layered-context.test.js
node tests/semantic-editor.test.js
node tests/verification-pipeline.test.js
node tests/entropy-monitor.test.js
node tests/cognitive-architecture.test.js
node tests/session-branches.test.js
node examples/layered-context-example.js
node examples/cognitive-memory-example.js
node examples/verification-pipeline-example.js
node examples/entropy-monitor-example.js
node examples/session-branching-example.js
node scripts/benchmark-semantic-editor.js
node scripts/benchmark-verification-pipeline.js
node scripts/simulate-entropy-monitor.js
```

## Deterministic semantic editing

A semantic patching engine is available at:

```text
src/semantic-editor.js
```

It replaces stale line-number patching and naive search/replace with content hashes, semantic region identities, AST-like node identities, structural neighbourhood signatures, token/dependency anchoring, transactional rollback, optimistic concurrency checks, semantic diffing, dependency impact analysis, and integrity metrics.

Docs, tests, and benchmark/corruption simulation:

```bash
node tests/semantic-editor.test.js
node scripts/benchmark-semantic-editor.js
```

See `docs/semantic-editing.md` for migration and compatibility guidance.

## Model-side reasoning runtime

Reasoning belongs to the model. The harness provides cognitive runtime scaffolding at:

```text
src/reasoning-runtime.js
```

It records explicit plan artifacts, task decompositions, hypotheses, decision records, executor actions, verifier evidence, feedback loops, memory updates, branch comparisons, reflection checkpoints, and failure analyses. It separates private scratchpad references from public result artifacts and does not treat reflection as proof. Automatic context injection sends the full scaffold once, then only changed objective/evidence/constraint/warning sections; repeated objectives, successful proof history, and stable router guidance are deduplicated. Metadata telemetry records rendered/injected/saved character counts without context text.

Docs and tests:

```bash
node tests/reasoning-runtime.test.js
node tests/cognitive-architecture.test.js
```

See `docs/reasoning-runtime.md` for the runtime contract, artifact validation, cleanup workflow, debug/export/replay support, model-facing templates, and `/reasoning-*` command reference. See `docs/adr-reasoning-runtime.md` for the architecture decision record and `docs/reasoning-runtime-stabilization.md` for the 2026-05-19 stabilization checkpoint covering the runtime banner, self-test, TUI smoke, memory dedupe, and validation workflow. `src/cognitive-architecture.js` remains only as a compatibility facade for older imports.

## Verification-gated execution pipeline

A proof-producing execution pipeline is available at:

```text
src/verification-pipeline.js
```

It makes verification a mandatory execution primitive: patch application is followed by differential impact analysis, dependency-aware verifier graph scheduling, result caching, policy enforcement, proof evidence emission, rollback/retry, benchmark and coverage deltas, confidence metrics, and feedback hooks for planner/coder/memory agents.

Docs, test, example, and benchmark:

```bash
node tests/verification-pipeline.test.js
node examples/verification-pipeline-example.js
node scripts/benchmark-verification-pipeline.js
```

See `docs/verification-pipeline.md` for the architecture and API.

## Entropy monitoring and session stability

A full entropy-monitoring subsystem is available at:

```text
src/entropy-monitor.js
```

It tracks context growth, retry depth, contradiction frequency, patch instability/reversion, hallucinated tool calls, verifier failure density, semantic drift, branch divergence and token inefficiency. It continuously produces entropy, stability, coherence and confidence scores; detects conflicting assumptions/plans/architecture/objectives; recommends auto-stabilization actions; sanitizes context; persists long-term metrics; and renders ASCII/HTML diagnostics.

Docs, tests, examples and simulation:

```bash
node tests/entropy-monitor.test.js
node examples/entropy-monitor-example.js
node scripts/simulate-entropy-monitor.js
```

See `docs/entropy-monitoring.md` for the architecture and API.

## Session branching and trajectory management

A cognitive trajectory management subsystem is available at:

```text
src/session-branches.js
```

It supports branchable sessions, experimental/verification/rollback/speculative/multi-agent branch types, full cognitive snapshots (memory/context/tool/filesystem/verifier state), semantic three-way merges, conflict detection, invariant gates, scoring, automatic risky-operation isolation, pruning, rollback/quarantine/replay recovery, agent leases, and ASCII visualization.

Docs, test, and runnable example:

```bash
node tests/session-branches.test.js
node examples/session-branching-example.js
```

See `docs/session-branching.md` for the architecture and API.

## Shared extension kit

Common extension helpers live in:

```text
src/pi-extension-kit.js
```

It provides `readJson`/`writeJson`, `short` truncation, `envEnabled`, `includeGlobal`, `execCapture`, and `registerOperationTool` so extension `index.ts` files stop copy-pasting the same scaffolding. Extensions under `.pi/extensions/` import it through the same allowlisted boundary as other `src/` facades (`tests/extension-import-boundary.test.js`), and `tests/extension-load.test.js` loads every extension through Pi's own TS loader against a stub API to catch broken imports or registration at test time — no model call required.

All Hermes consumers use the typed advisory adapter behind the integration boundary:

```text
src/integration-boundary.js → src/hermes-advisory.js → src/hermes-client.js
```

Only the adapter invokes the shared client. It owns bounded one-shot requests, readiness proofs, typed schemas, privacy scanning, repair limits, and metadata-only receipts. Goal control, Obsidian candidate curation, and Agent Skill drafting do not call Hermes subprocesses directly. Prompt suggestions use the configured Pi model through the provider-neutral model registry and do not depend on Hermes.

## Pi core integration boundary

A clean adapter boundary for the cognitive libraries is available at:

```text
src/integration-boundary.js
src/integration-config.js
src/file-integration-storage.js
src/trace-observability.js
```

Pi core should depend on adapters, not scattered direct imports from subsystem internals. The boundary includes injectable storage, logging/tracing sinks, per-subsystem disable switches, filesystem-backed storage, reusable trace runtime/storage/replay, and in-memory reference implementations for independent tests.

Docs and test:

```text
docs/integration-boundary.md
docs/runtime-configuration.md
docs/interactive-validation.md
tests/integration-boundary.test.js
tests/*adapter*.test.js
tests/disabled-side-effects.test.js
tests/extension-import-boundary.test.js
```

## Cognitive automation extension

A project-local automation extension is available at:

```text
.pi/extensions/reasoning-runtime/index.ts
```

It wires the repo subsystems into Pi automatically: cognitive memory recall/consolidation, layered context injection, semantic edit observation, model-side reasoning scaffold artifacts, verification debounce after mutations, entropy/stability monitoring, and cognitive session checkpoints/branches. Branch merge and rollback are explicit guarded commands: merge is dry-run by default, rollback is dry-run by default and creates a pre-rollback checkpoint before applying. Recovery snapshots exclude private runtime paths/transcript-shaped state, are size-capped and private, and remain local; exports contain lineage and aggregate metadata only. Cleanup is preview-first and protects snapshots reachable from live branch lineage.

Useful commands inside Pi:

```text
/cognitive-status
/cognitive-context [query]
/cognitive-memory [query]
/cognitive-verify
/cognitive-branches
/cognitive-entropy
/branch-list
/branch-show <branch-id>
/branch-export <branch-id>
/branch-cleanup-preview
/branch-cleanup-apply --yes
/branch-diff <left-branch-id> <right-branch-id>
/branch-merge <left-branch-id> <right-branch-id> [--apply] [--force]
/branch-rollback <branch-id> [snapshot-id] [--apply|--yes]
```

Runtime state is stored under:

```text
.pi/cognitive-automation/
```

Environment knobs:

```text
PI_COGNITIVE_AUTOMATION=0
PI_COGNITIVE_AUTO_INJECT=0
PI_COGNITIVE_AUTO_VERIFY=0
PI_COGNITIVE_BRANCHING_ENABLED=0
PI_COGNITIVE_AUTO_BRANCH=0
PI_COGNITIVE_AUTO_CHECKPOINT=0
PI_COGNITIVE_VERIFY_DEBOUNCE_MS=1500
PI_COGNITIVE_CHECKPOINT_DEBOUNCE_MS=2500
PI_COGNITIVE_CONTEXT_BUDGET_TOKENS=1800
PI_COGNITIVE_INJECT_MAX_CHARS=2500
PI_BRANCH_SNAPSHOT_MAX_BYTES=8388608
PI_BRANCH_MAX_SNAPSHOTS=200
PI_BRANCH_RETENTION_DAYS=30
```

Prompt suggestions wait for Pi's post-retry `agent_settled` boundary and keep the original deterministic local guidance immediate. A separately configured machine-wide Pi model restores the original best-next-prompt instruction and eight-message recent-context shape; context is text-only, scanner-redacted, capped per message, and bounded to 6,000 characters by default. The model is chosen with `/prompt-suggestions-model` and remembered in `<agent-dir>/prompt-suggestions.json`; it is independent of the session model. Refinement defaults to evidence-gated `auto`; `=1` is an explicit force-on override and `=0` disables refinement. Explicit `Ctrl+R` retry always requests a fresh attempt. Telemetry records only source/action/outcome/latency and a fixed categorical reason code, never suggestion, errors, or session text.

## Trace observability extension

A project-local tracing extension is available at:

```text
.pi/extensions/trace-observability/index.ts
```

It provides structured event tracing, prompt snapshots, diff tracking, metrics, replay inspection, JSON export, live/timeline/error views, append-only rotated JSONL storage, optional SQLite mirroring, and automatic failure-analysis events.

Docs:

```text
docs/trace-observability.md
examples/trace-workflow.md
```

Useful commands inside Pi:

```text
/trace-status
/trace-live [filter]
/trace-timeline
/trace-errors
/trace-export [correlation_id]
/trace-replay summary
/trace-replay step <index>
```

Trace storage rotates the active JSONL at `PI_TRACE_ROTATE_BYTES` (default 25MB) and prunes the oldest rotated files whenever the per-project trace directory exceeds `PI_TRACE_MAX_TOTAL_BYTES` (default 128MB). Active session files are never pruned.

Benchmark append overhead:

```bash
scripts/benchmark-trace-observability.sh
```


---

[Back to the README](../README.md) · [Wiki index](README.md)
